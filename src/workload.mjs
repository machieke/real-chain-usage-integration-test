import { signDeploy, vaultAddress, publicKey, sleep } from './chain.mjs';
import { voteTerm, lockTerm } from './terms.mjs';
import { messageTerm } from './acmp-terms.mjs';
import { hexlify, toUtf8Bytes, isAddress } from 'ethers';

export function validateConfig(config) {
  const c = { voters: 1000, bridgeUsers: 10, messagesPerUser: 10, windowMs: 25_000,
    completionTimeoutMs: 900_000, pollMs: 5000, stabilityMs: 10_000,
    maxInflight: 128, phloLimit: 100_000_000, phloPrice: 1, amount: 100_000_000,
    sourceChainId: 0, destinationChainId: 31337, evmConfirmations: 2, ...config };
  for (const name of ['voters', 'bridgeUsers', 'messagesPerUser', 'windowMs', 'completionTimeoutMs',
    'pollMs', 'stabilityMs', 'maxInflight', 'phloLimit', 'phloPrice', 'amount', 'evmConfirmations']) {
    if (!Number.isSafeInteger(c[name]) || c[name] <= 0) throw new Error(`Invalid ${name}`);
  }
  if (c.windowMs < 20_000 || c.windowMs > 30_000) throw new Error('windowMs must be 20000–30000');
  if (c.messagesPerUser < 5 || c.messagesPerUser > 10) throw new Error('messagesPerUser must be 5–10');
  for (const field of ['sourceChainId', 'destinationChainId']) {
    if (!Number.isSafeInteger(c[field]) || c[field] < 0) throw new Error(`Invalid ${field}`);
  }
  if (c.protocol === 'acmp' && c.sourceApps?.length !== c.bridgeUsers) throw new Error('Provide one ACMP sender per bridge user');
  if (!c.recipients.every(isAddress)) throw new Error('Every recipient must be a valid EVM address');
  if (c.voterKeys.length !== c.voters || c.bridgeKeys.length !== c.bridgeUsers ||
      c.recipients.length !== c.bridgeUsers) throw new Error('Provide one key per user and one recipient per bridge user');
  const keys = [c.ownerKey, ...c.voterKeys, ...c.bridgeKeys];
  if (new Set(keys.map(publicKey)).size !== keys.length) throw new Error('All ASI user keys, including the owner, must be distinct');
  return c;
}

export function makeWorkload(c, ballot, validAfterBlockNumber, shardId) {
  const items = [];
  const timestamp = Date.now();
  const options = { timestamp, phloLimit: c.phloLimit, phloPrice: c.phloPrice,
    phloEncoding: c.phloEncoding, validAfterBlockNumber, shardId };
  for (let user = 0; user < c.voters; user++) {
    const choice = user % 2 === 0 ? 'yes' : 'no';
    items.push({ kind: 'vote', user, choice, voter: vaultAddress(c.voterKeys[user]),
      scheduledMs: user * c.windowMs / c.voters,
      signed: signDeploy(c.voterKeys[user], voteTerm(ballot, choice), options) });
  }
  for (let user = 0; user < c.bridgeUsers; user++) {
    for (let message = 0; message < c.messagesPerUser; message++) {
      const slot = message * c.bridgeUsers + user;
      const payload = c.protocol === 'acmp' ? hexlify(toUtf8Bytes(JSON.stringify({ run: c.runId, user, message }))) : undefined;
      items.push({ payload, kind: 'bridge', user, message, amount: c.amount, recipient: c.recipients[user],
        scheduledMs: (slot + 0.5) * c.windowMs / (c.bridgeUsers * c.messagesPerUser),
        signed: signDeploy(c.bridgeKeys[user], c.protocol === 'acmp' ? messageTerm(c.sourceApps[user].uri, payload) :
          lockTerm(c.bridgeUri, c.amount, c.recipients[user], c.destinationChainId),
          { ...options, timestamp: timestamp + message }) });
    }
  }
  return items.sort((a, b) => a.scheduledMs - b.scheduledMs).map(item => ({ ...item, id: item.signed.signature }));
}

// Open-loop pacing: finalization and bridge progress never throttle offered load.
// Saturation fails the run instead of silently moving work outside the window.
export async function submitWorkload(items, chain, c, emit = () => {}) {
  const start = performance.now();
  const inflight = new Set();
  for (const item of items) {
    if (!c.signal?.aborted) await sleep(start + item.scheduledMs - performance.now());
    item.startedMs = performance.now() - start;
    if (c.signal?.aborted || item.startedMs >= c.windowMs || inflight.size >= c.maxInflight) {
      item.submissionError = 'Load generator missed window or exhausted maxInflight';
      emit({ event: 'submission', ...publicItem(item) });
      continue;
    }
    const promise = (async () => {
      try {
        const ack = await chain.submit(item.signed, 30_000 - item.startedMs);
        if (typeof ack !== 'string' || !ack.startsWith('Success!') || !ack.toLowerCase().includes(item.id.toLowerCase())) {
          throw new Error('Deploy acknowledgement did not contain the signed deploy ID');
        }
        item.accepted = true;
      } catch (error) {
        item.submissionError = error.message;
      } finally {
        item.finishedMs = performance.now() - start;
        emit({ event: 'submission', ...publicItem(item) });
      }
    })();
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise));
  }
  await Promise.all(inflight);
  return { durationMs: performance.now() - start,
    firstStartedMs: Math.min(...items.map(i => i.startedMs)),
    lastStartedMs: Math.max(...items.map(i => i.startedMs)),
    accepted: items.filter(i => i.accepted).length };
}

export function publicItem({ signed, ...item }) { return { ...item, deployer: signed.deployer }; }

export async function mapLimit(items, limit, fn) {
  let index = 0, failure;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && index < items.length) {
      const i = index++;
      try { results[i] = await fn(items[i], i); }
      catch (error) { failure ??= { error }; }
    }
  }));
  // Drain already-started operations before returning an error. Otherwise a
  // subsequent polling round can overlap abandoned workers from this one.
  if (failure) throw failure.error;
  return results;
}

export function voteDifferences(items, actual) {
  const expected = Object.fromEntries(items.filter(i => i.kind === 'vote').map(i => [i.voter, i.choice]));
  const missing = Object.keys(expected).filter(key => !(key in actual));
  const wrong = Object.keys(expected).filter(key => key in actual && actual[key] !== expected[key]);
  const unexpected = Object.keys(actual).filter(key => !(key in expected));
  return { missing, wrong, unexpected, ok: !missing.length && !wrong.length && !unexpected.length };
}
