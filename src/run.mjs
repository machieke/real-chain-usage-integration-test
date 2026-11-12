import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Contract, JsonRpcProvider, FetchRequest } from 'ethers';
import { Chain, sleep } from './chain.mjs';
import { makeWorkload, mapLimit, publicItem, submitWorkload, validateConfig } from './workload.mjs';
import { bridgeQuery, snapshotTerm } from './terms.mjs';
import { bridgeAbi, tokenAbi, bridgeRows, sourceSnapshot, destinationSnapshot } from './verify.mjs';

export async function run(config, log = console.log) {
  const c = validateConfig(config);
  const dir = resolve(c.artifactDir ?? `artifacts/${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  const emit = event => appendFileSync(resolve(dir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  const report = { passed: false, startedAt: new Date().toISOString(), artifactDir: dir,
    scenario: { voters: c.voters, bridgeUsers: c.bridgeUsers, messagesPerUser: c.messagesPerUser,
      windowMs: c.windowMs, completionTimeoutMs: c.completionTimeoutMs,
      stabilityMs: c.stabilityMs, sourceChainId: c.sourceChainId, destinationChainId: c.destinationChainId,
      amount: c.amount, phloLimit: c.phloLimit, phloPrice: c.phloPrice, evmConfirmations: c.evmConfirmations },
    metadata: c.metadata ?? {}, errors: [] };
  const chain = new Chain(c.chainUrl);
  if (!c.observerUrls?.length) throw new Error('At least one observer URL is required for canonical state verification');
  const observers = c.observerUrls.map(url => new Chain(url, { timeoutMs: 30_000 }));
  for (const client of [chain, ...observers]) client.signal = c.signal;
  const pool = new pg.Pool({ connectionString: c.databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 15_000 });
  const rpc = new FetchRequest(c.evmUrl);
  rpc.timeout = 15_000;
  const provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  let items = [];
  try {
    log(`Artifacts: ${dir}`);
    const status = await chain.request('/status');
    if (!status.isReady) throw new Error('ASI node is not ready');
    if (Number((await provider.getNetwork()).chainId) !== c.destinationChainId) throw new Error('Destination chain ID mismatch');
    const token = new Contract(c.evmToken, tokenAbi, provider);
    const bridge = new Contract(c.evmBridge, bridgeAbi, provider);
    if ((await bridge.token()).toLowerCase() !== c.evmToken.toLowerCase()) throw new Error('Destination token mismatch');
    const decimals = Number(await token.decimals());
    if (decimals < 8) throw new Error('Destination decimals must be >= ASI shared decimals (8)');
    await pool.query('SELECT 1 FROM relayed_messages LIMIT 1');
    for (const observer of observers) {
      const block = await observer.finalizedBlock();
      const [allowed] = await observer.explore(bridgeQuery(c.bridgeUri, 'allowedDestinations'), block.blockHash);
      if (!Array.isArray(allowed) || !allowed.includes(c.destinationChainId)) throw new Error('Bridge destination not enabled');
    }
    log('Deploying the voting contract before the load window');
    const term = await readFile(new URL('../contracts/vote.rho', import.meta.url), 'utf8');
    const deployment = await chain.deploy(c.ownerKey, term, { shardId: status.shardId,
      validAfterBlockNumber: (await chain.finalizedBlock()).blockNumber, phloLimit: c.phloLimit, phloPrice: c.phloPrice });
    const ballot = deployment.data.find(v => typeof v === 'string' && v.startsWith('rho:id:'));
    if (!ballot) throw new Error('Vote contract did not return a registry URI');
    report.ballot = { uri: ballot, deployId: deployment.id };
    // Wait for each read replica to observe setup before starting the timer.
    for (const observer of observers) {
      const deadline = performance.now() + 120_000;
      let ready = false;
      while (performance.now() < deadline && !ready) {
        try {
          const block = await observer.finalizedBlock();
          const [votes] = await observer.explore(snapshotTerm(ballot), block.blockHash);
          ready = votes && typeof votes === 'object' && Object.keys(votes).length === 0;
        } catch { /* Observer replication can lag setup finality. */ }
        if (!ready) await sleep(1000);
      }
      if (!ready) throw new Error(`Observer did not see voting contract: ${observer.url}`);
    }
    const blockNumber = await provider.getBlockNumber();
    const balances = Object.fromEntries(await Promise.all([...new Set(c.recipients.map(r => r.toLowerCase()))]
      .map(async recipient => [recipient, String(await token.balanceOf(recipient, { blockTag: blockNumber }))])));
    const baseline = { blockNumber, balances, scale: 10n ** BigInt(decimals - 8) };
    report.destinationBaseline = { ...baseline, scale: String(baseline.scale) };
    items = makeWorkload(c, ballot, (await chain.finalizedBlock()).blockNumber, status.shardId);
    await writeFile(resolve(dir, 'manifest.json'), JSON.stringify(items.map(publicItem), null, 2));
    await writeFile(resolve(dir, 'signed-deploys.json'), JSON.stringify(items.map(i => i.signed), null, 2));
    log(`Submitting ${c.voters} votes and ${c.bridgeUsers * c.messagesPerUser} bridge locks over ${c.windowMs / 1000}s`);
    report.submission = await submitWorkload(items, chain, c, emit);
    if (items.some(i => !i.accepted || i.finishedMs > 30_000 || i.startedMs >= c.windowMs)) {
      report.errors.push('Not every deploy was submitted within the load window and acknowledged within 30 seconds');
    }
    log(`Accepted ${report.submission.accepted}/${items.length}; waiting for canonical finality and bridge delivery`);
    const drainStart = performance.now(), deadline = drainStart + c.completionTimeoutMs;
    for (const client of [chain, ...observers]) client.deadline = deadline;
    c.deadline = deadline;
    let stableSince, stableHeights, lastProgress = '';
    while (performance.now() < deadline) {
      if (c.signal?.aborted) throw new Error('Run interrupted');
      await mapLimit(items.filter(i => i.finality?.state !== 'Finalized' || !i.execution), 24, async item => {
        try {
          item.finality = await chain.status(item.id);
          delete item.pollError;
          if (item.finality.state === 'Finalized') {
            const detail = await chain.execution(item.id, item.finality);
            item.execution = { errored: detail.errored, systemDeployError: detail.systemDeployError,
              cost: detail.cost, blockHash: detail.blockHash, blockNumber: detail.blockNumber };
            item.finalizedAfterMs = performance.now() - drainStart;
            emit({ event: 'finality', ...publicItem(item) });
          }
        } catch (error) { item.pollError = error.message; }
      });
      const counts = { finalized: items.filter(i => i.finality?.state === 'Finalized' && i.execution).length,
        failed: items.filter(i => ['Failed', 'Expired'].includes(i.finality?.state)).length };
      let rows = [];
      try {
        rows = await bridgeRows(pool, items.filter(i => i.kind === 'bridge'));
        report.bridgeRows = rows;
      } catch (error) { report.lastReadError = error.message; }
      const progress = `${counts.finalized}/${items.length} finalized; ${rows.filter(r => r.location === 'archive').length}/${c.bridgeUsers * c.messagesPerUser} bridged`;
      if (progress !== lastProgress) { log(progress); lastProgress = progress; }
      emit({ event: 'progress', ...counts, archived: rows.filter(r => r.location === 'archive').length });
      if (counts.failed || items.some(i => i.execution?.errored || i.execution?.systemDeployError)) {
        report.errors.push('A deploy reached Failed/Expired or reported an execution error');
        break;
      }
      let consistent = false;
      if (counts.finalized === items.length) {
        try {
          report.sources = [];
          for (const observer of observers) report.sources.push(await sourceSnapshot(c, observer, ballot, items));
          report.destination = await destinationSnapshot(c, provider, rows, report.sources[0].locks,
            items.filter(i => i.kind === 'bridge'), baseline);
          const locks = JSON.stringify(report.sources[0].locks.map(l => [l.id, l.nonce]));
          consistent = report.sources.every(s => s.ok && JSON.stringify(s.locks.map(l => [l.id, l.nonce])) === locks) && report.destination.ok;
          delete report.lastReadError;
        } catch (error) { report.lastReadError = error.message; }
      }
      if (consistent && performance.now() < deadline) {
        if (stableSince === undefined) {
          stableSince = performance.now();
          stableHeights = report.sources.map(s => s.block.blockNumber);
          log('All effects reconciled; checking that they persist across later finalized blocks');
        } else if (performance.now() - stableSince >= c.stabilityMs &&
          report.sources.every((s, i) => s.block.blockNumber > stableHeights[i])) {
          report.consistency = { converged: true, drainMs: performance.now() - drainStart,
            stableMs: performance.now() - stableSince, initialHeights: stableHeights,
            finalHeights: report.sources.map(s => s.block.blockNumber) };
          report.passed = report.errors.length === 0;
          break;
        }
      } else { stableSince = undefined; }
      await sleep(Math.min(c.pollMs, Math.max(0, deadline - performance.now())));
    }
    if (!report.consistency?.converged && !report.errors.length) report.errors.push('Eventual consistency deadline exceeded');
  } catch (error) {
    report.errors.push(error.message);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.deploys = items.map(publicItem);
    report.summary = {
      expected: items.length, accepted: items.filter(i => i.accepted).length,
      finalized: items.filter(i => i.finality?.state === 'Finalized').length,
      failed: items.filter(i => ['Failed', 'Expired'].includes(i.finality?.state)).map(i => i.id),
      unresolved: items.filter(i => i.finality?.state !== 'Finalized').map(i => i.id),
      bridgeArchived: report.bridgeRows?.filter(r => r.location === 'archive').length ?? 0,
      destinationVerified: report.destination?.messages?.filter(m => m.ok).length ?? 0,
    };
    await writeFile(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
    await pool.end();
    provider.destroy();
  }
  log(`${report.passed ? 'PASS' : 'FAIL'}: ${resolve(dir, 'report.json')}`);
  return report;
}
