import { Contract, Interface, keccak256, concat, toUtf8Bytes, zeroPadValue } from 'ethers';
import protobuf from 'protobufjs';
import { snapshotTerm, bridgeQuery } from './terms.mjs';
import { packetBatchQuery } from './acmp-terms.mjs';
import { mapLimit, voteDifferences } from './workload.mjs';

const Par = protobuf.parse('syntax="proto3"; message Par { repeated Expr exprs=5; } message Expr { oneof value { sint64 gInt=2; } }').root.lookupType('Par');
const rhoInt = n => Par.encode(Par.fromObject({ exprs: [{ gInt: n }] })).finish();
export const hex = value => typeof value === 'string' ? `0x${value.replace(/^0x/, '').toLowerCase()}` : value;
export function packetGuid(p) {
  return keccak256(concat([toUtf8Bytes('ASI_ACMP_GUID_V1'), rhoInt(p.version), rhoInt(p.sourceChainId),
    p.sourceEndpointId, p.sourceAppId, rhoInt(p.destinationChainId), p.destinationEndpointId,
    keccak256(p.destinationAppId), rhoInt(p.channelNonce), p.payloadHash]));
}
export function expectedPacket(c, item, channelNonce) {
  const p = { version: 1, sourceChainId: c.sourceChainId, sourceEndpointId: c.sourceEndpointId,
    sourceAppId: hex(c.sourceApps[item.user].sourceAppId), destinationChainId: c.destinationChainId,
    destinationEndpointId: c.destinationEndpointId, destinationAppId: zeroPadValue(item.recipient, 32).toLowerCase(),
    channelNonce, payloadHash: keccak256(item.payload), payload: item.payload };
  return { ...p, guid: packetGuid(p) };
}
export function packetEqual(actual, expected) {
  return actual && Object.entries(expected).every(([key, value]) =>
    typeof value === 'number' ? actual[key] === value : hex(actual[key]) === hex(value));
}
export const endpointAbi = [
  'function endpointId() view returns (bytes32)',
  'function trustedEndpoints(uint256) view returns (bytes32)',
  'function packetState(bytes32) view returns (bool received,bool processed)',
  'function getReceivedPacket(bytes32) view returns (tuple(uint256 version,uint256 sourceChainId,bytes32 sourceEndpointId,bytes32 sourceAppId,uint256 destinationChainId,bytes32 destinationEndpointId,bytes32 destinationAppId,uint256 channelNonce,bytes32 payloadHash,bool received,bool processed))',
  'event PacketReceived(bytes32 indexed guid,uint256 indexed sourceChainId,bytes32 indexed sourceAppId,bytes32 destinationAppId,uint256 channelNonce,bytes32 payloadHash)',
  'event PacketProcessed(bytes32 indexed guid,bytes32 indexed destinationAppId)',
];
const receiverAbi = ['function received(bytes32) view returns (bool)', 'function payloads(bytes32) view returns (bytes)'];

export async function bridgeRows(pool) {
  // The fixture database is isolated; include unexpected rows so they cannot hide.
  return (await pool.query(`SELECT 'active' AS location, status, method, params, source_tx_hash, source_chain,
    destination_chain, source_chain_tx_id, last_error, endpoint_receive_tx_hash, NULL::text AS relay_tx_hash
    FROM messages UNION ALL SELECT 'archive', 'relayed', method, params, source_tx_hash, source_chain,
    destination_chain, source_chain_tx_id, NULL::text, endpoint_receive_tx_hash, relay_tx_hash FROM relayed_messages`)).rows;
}
export function checkRow(c, item, packet, rows) {
  const matches = rows.filter(r => hex(r.source_tx_hash) === packet.guid || hex(r.source_chain_tx_id) === hex(item.id));
  if (matches.length !== 1) return { ok: false, reason: `Expected one packet row, found ${matches.length}` };
  const row = matches[0];
  const ok = row.location === 'archive' && row.method === 'endpoint_v1' &&
    hex(row.source_tx_hash) === packet.guid && hex(row.source_chain_tx_id) === hex(item.id) &&
    row.source_chain === String(c.sourceChainId) && row.destination_chain === String(c.destinationChainId) &&
    packetEqual(row.params?.__packet, packet) &&
    [row.relay_tx_hash, row.endpoint_receive_tx_hash].every(v => /^0x[0-9a-f]{64}$/i.test(v ?? ''));
  return { ok, reason: ok ? undefined : 'Packet archive does not match the submitted message', row };
}
export async function sourceSnapshot(c, observer, ballot, items) {
  const block = await observer.finalizedBlock();
  const [actual] = await observer.explore(snapshotTerm(ballot), block.blockHash);
  if (!actual || Array.isArray(actual) || typeof actual !== 'object') throw new Error('Vote snapshot missing');
  const votes = voteDifferences(items, actual);
  const [outbound] = await observer.explore(bridgeQuery(c.bridgeUri, 'outboundNonce'), block.blockHash);
  const receipts = await mapLimit(items.filter(i => i.kind === 'bridge'), 8, async item => {
    const data = await observer.data(item.id, item.execution.blockHash);
    const results = data.filter(v => v?.status === 'ok');
    const result = results[0];
    const valid = results.length === 1 && [result.recordNonce, result.channelNonce].every(n => Number.isSafeInteger(n) && n >= 0);
    return { item, result, valid, data };
  });
  const nonces = receipts.filter(r => r.valid).map(r => r.result.recordNonce);
  const historyByNonce = {};
  for (let i = 0; i < nonces.length; i += 10) {
    const [batch] = await observer.explore(packetBatchQuery(c.bridgeUri, nonces.slice(i, i + 10)), block.blockHash);
    if (!batch || typeof batch !== 'object') throw new Error('Missing packet history batch');
    Object.assign(historyByNonce, batch);
  }
  const locks = receipts.map(({ item, result, valid, data }) => {
    if (!valid) return { id: item.id, ok: false, reason: 'Missing successful packet receipt or invalid nonce', data };
    const packet = expectedPacket(c, item, result.channelNonce);
    const history = historyByNonce[result.recordNonce];
    const ok = hex(result.guid) === packet.guid && packetEqual(history, packet) && hex(history?.sourceDeploy) === hex(item.id);
    return { id: item.id, user: item.user, ok, nonce: result.recordNonce, packet, history };
  });
  const unique = nonces.length === locks.length && [...nonces].sort((a, b) => a - b).every((n, i) => n === i) && new Set(locks.map(l => l.packet?.guid)).size === locks.length;
  const channels = Array.from({ length: c.bridgeUsers }, (_, user) => locks.filter(l => l.user === user)
    .map(l => l.packet?.channelNonce).sort((a, b) => a - b));
  const completeChannels = channels.every(ns => ns.length === c.messagesPerUser && ns.every((n, i) => n === i));
  const tally = Object.values(actual).reduce((a, v) => ({ ...a, [v]: (a[v] ?? 0) + 1 }), {});
  return { url: observer.url, exploreUrl: observer.exploreUrl ?? observer.url, block, votes, ballots: actual, tally,
    voteCount: Object.keys(actual).length, outbound, locks, channels,
    ok: votes.ok && outbound === locks.length && unique && completeChannels && locks.every(l => l.ok) };
}
export async function destinationSnapshot(c, provider, rows, locks, items, baseline) {
  const endpoint = new Contract(c.evmBridge, endpointAbi, provider), iface = new Interface(endpointAbi);
  const blockNumber = await provider.getBlockNumber() - c.evmConfirmations + 1;
  if (blockNumber < baseline.blockNumber) return { ok: false, reason: 'Awaiting confirmations' };
  const block = await provider.getBlock(blockNumber);
  const logs = (await provider.getLogs({ address: c.evmBridge, fromBlock: baseline.blockNumber + 1, toBlock: blockNumber }))
    .map(log => ({ log, event: iface.parseLog(log) })).filter(x => ['PacketReceived', 'PacketProcessed'].includes(x.event?.name));
  const messages = await mapLimit(items, 8, async item => {
    if (performance.now() >= c.deadline || c.signal?.aborted) throw new Error('Completion deadline exceeded or run interrupted');
    const lock = locks.find(l => l.id === item.id);
    if (!lock?.ok) return { id: item.id, ok: false, reason: 'Source packet not reconciled' };
    const packet = lock.packet, checked = checkRow(c, item, packet, rows);
    if (!checked.ok) return { id: item.id, ...checked };
    for (const [name, tx] of [['PacketReceived', checked.row.endpoint_receive_tx_hash], ['PacketProcessed', checked.row.relay_tx_hash]]) {
      const matches = logs.filter(l => l.event.name === name && l.event.args.guid === packet.guid);
      const receipt = await provider.getTransactionReceipt(tx);
      if (matches.length !== 1 || !receipt || receipt.status !== 1 || receipt.blockNumber > blockNumber ||
          receipt.hash !== matches[0].log.transactionHash || receipt.blockHash !== matches[0].log.blockHash ||
          receipt.to?.toLowerCase() !== c.evmBridge.toLowerCase() ||
          (await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) {
        return { id: item.id, ok: false, reason: `Missing, duplicate, failed, or noncanonical ${name} transaction` };
      }
      const args = matches[0].event.args;
      if (args.destinationAppId !== packet.destinationAppId || name === 'PacketReceived' &&
          (Number(args.sourceChainId) !== packet.sourceChainId || args.sourceAppId !== packet.sourceAppId ||
          Number(args.channelNonce) !== packet.channelNonce || args.payloadHash !== packet.payloadHash)) {
        return { id: item.id, ok: false, reason: 'Destination event fields mismatch' };
      }
    }
    const saved = await endpoint.getReceivedPacket(packet.guid, { blockTag: blockNumber });
    const header = Object.fromEntries(Object.keys(packet).filter(k => !['guid', 'payload'].includes(k))
      .map(k => [k, typeof saved[k] === 'bigint' ? Number(saved[k]) : saved[k]]));
    const expectedHeader = Object.fromEntries(Object.entries(packet).filter(([k]) => !['guid', 'payload'].includes(k)));
    const receiver = new Contract(item.recipient, receiverAbi, provider);
    const ok = saved.received && saved.processed && packetEqual(header, expectedHeader) &&
      await receiver.received(packet.guid, { blockTag: blockNumber }) &&
      hex(await receiver.payloads(packet.guid, { blockTag: blockNumber })) === packet.payload;
    return { id: item.id, guid: packet.guid, ok, relayTx: checked.row.relay_tx_hash, receiveTx: checked.row.endpoint_receive_tx_hash };
  });
  return { blockNumber, blockHash: block.hash, confirmations: c.evmConfirmations, messages, eventCount: logs.length,
    ok: rows.length === items.length && logs.length === items.length * 2 && messages.every(m => m.ok) &&
      new Set(messages.map(m => m.relayTx)).size === items.length && new Set(messages.map(m => m.receiveTx)).size === items.length };
}
