import { Contract, Interface, keccak256, solidityPackedKeccak256 } from 'ethers';
import { bridgeQuery, snapshotTerm } from './terms.mjs';
import { mapLimit, voteDifferences } from './workload.mjs';
import { vaultAddress } from './chain.mjs';

export const bridgeAbi = [
  'function processedSourceTx(uint256,bytes32) view returns (bool)',
  'function processedUnlocks(bytes32) view returns (bool)',
  'function token() view returns (address)',
  'event Unlocked(address indexed recipient,uint256 amount,bytes32 indexed proofHash,uint256 timestamp)',
];
export const tokenAbi = ['function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)', 'event Transfer(address indexed from,address indexed to,uint256 value)'];

export function proofHash(c, item, nonce, evmAmount) {
  return solidityPackedKeccak256(
    ['string', 'uint256', 'address', 'address', 'uint256', 'address', 'uint256', 'bytes32', 'uint256'],
    ['ASI_BRIDGE_UNLOCK_V1', c.destinationChainId, c.evmBridge, c.evmToken, c.sourceChainId,
      item.recipient, evmAmount, keccak256(`0x${item.id}`), nonce]);
}

export async function bridgeRows(pool, items) {
  const ids = items.map(i => i.id);
  const sourceIds = ids.map(id => keccak256(`0x${id}`));
  return (await pool.query(`
    SELECT 'active' AS location, status, params, source_tx_hash, source_chain, destination_chain,
      last_error, NULL::text AS relay_tx_hash FROM messages
      WHERE params->>'asiDeploySig' = ANY($1::text[]) OR source_tx_hash = ANY($2::text[])
    UNION ALL
    SELECT 'archive' AS location, 'relayed' AS status, params, source_tx_hash, source_chain, destination_chain,
      NULL::text AS last_error, relay_tx_hash FROM relayed_messages
      WHERE params->>'asiDeploySig' = ANY($1::text[]) OR source_tx_hash = ANY($2::text[])
  `, [ids, sourceIds])).rows;
}

export function checkRow(c, item, nonce, rows) {
  const sourceId = keccak256(`0x${item.id}`);
  const matches = rows.filter(r => r.params.asiDeploySig === item.id || r.source_tx_hash === sourceId);
  if (matches.length !== 1) return { ok: false, reason: `Expected one bridge row, found ${matches.length}`, rows: matches };
  const row = matches[0];
  if (row.location !== 'archive' || !/^0x[\da-f]{64}$/i.test(row.relay_tx_hash ?? '')) {
    return { ok: false, reason: 'Message not archived with a relay transaction', rows: matches };
  }
  const p = row.params;
  if (row.source_tx_hash !== sourceId || p.asiDeploySig !== item.id ||
      row.source_chain !== String(c.sourceChainId) || row.destination_chain !== String(c.destinationChainId) ||
      String(p.amount) !== String(item.amount) || String(p.nonce) !== String(nonce) ||
      String(p.destChainId) !== String(c.destinationChainId) || p.recipient?.toLowerCase() !== item.recipient.toLowerCase()) {
    return { ok: false, reason: 'Bridge row does not match submitted lock', rows: matches };
  }
  return { ok: true, row };
}

export async function sourceSnapshot(c, observer, ballot, items) {
  const block = await observer.finalizedBlock();
  const [actual] = await observer.explore(snapshotTerm(ballot), block.blockHash);
  if (!actual || Array.isArray(actual) || typeof actual !== 'object') throw new Error('Vote snapshot missing');
  const votes = voteDifferences(items, actual);
  const locks = await mapLimit(items.filter(i => i.kind === 'bridge'), 4, async item => {
    // getDataAtName is event-indexed: a later block with no send to this name
    // returns no result. Read the receipt at inclusion, then reconcile its
    // nonce against the current finalized contract state below.
    const data = await observer.data(item.id, item.execution.blockHash);
    const results = data.filter(v => v?.status === 'ok');
    if (results.length !== 1) return { id: item.id, ok: false, reason: 'Missing or unsuccessful lock result', data };
    const result = results[0];
    if (result.amount !== item.amount || result.destChainId !== c.destinationChainId ||
        !Number.isSafeInteger(result.nonce) || result.nonce < 0) {
      return { id: item.id, ok: false, reason: 'Lock result mismatch', data };
    }
    const history = {};
    for (const method of ['lockAmount', 'lockRecipient', 'lockDest', 'lockFromAddress']) {
      [history[method]] = await observer.explore(bridgeQuery(c.bridgeUri, method, result.nonce), block.blockHash);
    }
    const ok = history.lockAmount === item.amount && history.lockRecipient?.toLowerCase() === item.recipient.toLowerCase() &&
      history.lockDest === c.destinationChainId && history.lockFromAddress === vaultAddress(c.bridgeKeys[item.user]);
    return { id: item.id, ok, nonce: result.nonce, history };
  });
  const nonces = locks.filter(l => l.ok).map(l => l.nonce);
  const tally = Object.values(actual).reduce((counts, choice) => ({ ...counts, [choice]: (counts[choice] ?? 0) + 1 }), {});
  return { url: observer.url, block, votes, ballots: actual, tally, voteCount: Object.keys(actual).length, locks,
    ok: votes.ok && locks.every(l => l.ok) && new Set(nonces).size === locks.length };
}

export async function destinationSnapshot(c, provider, rows, locks, items, baseline) {
  const checkDeadline = () => {
    if (performance.now() >= c.deadline || c.signal?.aborted) throw new Error('Completion deadline exceeded or run interrupted');
  };
  checkDeadline();
  const bridge = new Contract(c.evmBridge, bridgeAbi, provider);
  const token = new Contract(c.evmToken, tokenAbi, provider);
  const iface = new Interface(bridgeAbi), tokenIface = new Interface(tokenAbi);
  const latest = await provider.getBlockNumber();
  const blockNumber = latest - c.evmConfirmations + 1;
  if (blockNumber < baseline.blockNumber) return { ok: false, reason: 'Awaiting destination confirmations' };
  const block = await provider.getBlock(blockNumber);
  const logs = await provider.getLogs({ address: c.evmBridge, fromBlock: baseline.blockNumber + 1,
    toBlock: blockNumber, topics: [iface.getEvent('Unlocked').topicHash] });
  const decoded = logs.map(log => ({ log, args: iface.parseLog(log).args }));
  const messages = await mapLimit(items, 8, async item => {
    checkDeadline();
    const lock = locks.find(l => l.id === item.id);
    if (!lock?.ok) return { id: item.id, ok: false, reason: 'Source lock not reconciled' };
    const rowCheck = checkRow(c, item, lock.nonce, rows);
    if (!rowCheck.ok) return { id: item.id, ...rowCheck };
    const amount = BigInt(item.amount) * baseline.scale;
    const digest = proofHash(c, item, lock.nonce, amount);
    const matches = decoded.filter(v => v.args.proofHash === digest);
    if (matches.length !== 1) return { id: item.id, ok: false, reason: `Expected one Unlocked event; found ${matches.length}` };
    const { log, args } = matches[0];
    const receipt = await provider.getTransactionReceipt(rowCheck.row.relay_tx_hash);
    if (!receipt || receipt.status !== 1 || receipt.blockNumber > blockNumber ||
        receipt.hash !== log.transactionHash || receipt.blockHash !== log.blockHash ||
        receipt.to?.toLowerCase() !== c.evmBridge.toLowerCase() ||
        (await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) {
      return { id: item.id, ok: false, reason: 'Missing, failed, unconfirmed, or noncanonical relay receipt' };
    }
    const transfers = receipt.logs.filter(l => l.address.toLowerCase() === c.evmToken.toLowerCase())
      .map(l => { try { return tokenIface.parseLog(l); } catch { return null; } })
      .filter(l => l?.name === 'Transfer' && l.args.from.toLowerCase() === c.evmBridge.toLowerCase() &&
        l.args.to.toLowerCase() === item.recipient.toLowerCase() && l.args.value === amount);
    const processed = await bridge.processedSourceTx(c.sourceChainId, keccak256(`0x${item.id}`), { blockTag: blockNumber });
    const proofProcessed = await bridge.processedUnlocks(digest, { blockTag: blockNumber });
    const ok = processed && proofProcessed && transfers.length === 1 && args.amount === amount &&
      args.recipient.toLowerCase() === item.recipient.toLowerCase();
    return { id: item.id, ok, proofHash: digest, relayTx: receipt.hash, blockNumber: receipt.blockNumber };
  });
  const balances = await Promise.all(Object.entries(baseline.balances).map(async ([recipient, before]) => {
    const expected = items.filter(i => i.recipient.toLowerCase() === recipient)
      .reduce((sum, i) => sum + BigInt(i.amount) * baseline.scale, 0n);
    const actual = await token.balanceOf(recipient, { blockTag: blockNumber }) - BigInt(before);
    return { recipient, expected: String(expected), actual: String(actual), ok: actual === expected };
  }));
  const uniqueTransactions = new Set(messages.filter(m => m.ok).map(m => m.relayTx)).size === items.length;
  return { blockNumber, blockHash: block.hash, confirmations: c.evmConfirmations, messages, balances,
    ok: uniqueTransactions && messages.every(m => m.ok) && balances.every(b => b.ok) };
}
