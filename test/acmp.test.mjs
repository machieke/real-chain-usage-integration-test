import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, zeroPadValue } from 'ethers';
import { expectedPacket, packetGuid, checkRow, endpointAbi, destinationSnapshot, sourceSnapshot } from '../src/acmp-verify.mjs';

const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
function fixture(change = {}) {
  const c = { protocol: 'acmp', evmBridge: address(1), sourceChainId: 0, destinationChainId: 31337,
    sourceEndpointId: hash(2), destinationEndpointId: zeroPadValue(address(1), 32),
    sourceApps: [{ sourceAppId: hash(3) }], bridgeUsers: 1, messagesPerUser: 1, evmConfirmations: 2 };
  const item = { id: 'abcd', kind: 'bridge', user: 0, recipient: address(4), payload: '0x1234', execution: { blockHash: 'inclusion' } };
  const packet = expectedPacket(c, item, 0), endpoint = new Interface(endpointAbi);
  const receiver = new Interface(['function received(bytes32) view returns (bool)', 'function payloads(bytes32) view returns (bytes)']);
  const log = (name, args, tx) => ({ ...endpoint.encodeEventLog(endpoint.getEvent(name), args),
    address: c.evmBridge, blockNumber: 10, blockHash: hash(10), transactionHash: hash(tx) });
  const logs = [log('PacketReceived', [packet.guid, 0, packet.sourceAppId, packet.destinationAppId, 0, packet.payloadHash], 100),
    log('PacketProcessed', [packet.guid, packet.destinationAppId], 101)];
  const provider = {
    getBlockNumber: async () => change.latest ?? 12,
    getBlock: async n => ({ hash: change.reorg ? hash(99) : hash(n) }),
    getLogs: async () => change.duplicate ? [...logs, logs[0]] : change.missing ? logs.slice(0, 1) : logs,
    getTransactionReceipt: async tx => ({ hash: tx, to: c.evmBridge, blockHash: hash(10), blockNumber: 10, status: change.failed ? 0 : 1 }),
    call: async tx => {
      if (tx.to.toLowerCase() === c.evmBridge) return endpoint.encodeFunctionResult('getReceivedPacket', [[
        1, 0, packet.sourceEndpointId, packet.sourceAppId, 31337, packet.destinationEndpointId, packet.destinationAppId,
        0, packet.payloadHash, true, change.processed ?? true]]);
      const fn = receiver.parseTransaction(tx).name;
      return receiver.encodeFunctionResult(fn, [fn === 'received' ? true : change.payload ?? item.payload]);
    },
  };
  const rows = [{ location: 'archive', method: 'endpoint_v1', source_tx_hash: packet.guid, source_chain_tx_id: item.id,
    source_chain: '0', destination_chain: '31337', params: { __packet: packet },
    endpoint_receive_tx_hash: hash(100), relay_tx_hash: hash(101) }];
  return [c, provider, rows, [{ id: item.id, nonce: 0, ok: true, packet }], [item], { blockNumber: 0 }];
}

test('ACMP archive must uniquely correlate the exact signed deploy, GUID, route and payload', () => {
  const [c, , rows, locks, [item]] = fixture();
  assert.equal(checkRow(c, item, locks[0].packet, rows).ok, true);
  for (const bad of [[], [...rows, ...rows], [{ ...rows[0], location: 'active' }],
    [{ ...rows[0], source_chain_tx_id: 'ffff' }], [{ ...rows[0], params: { __packet: { ...locks[0].packet, payload: '0xff' } } }]]) {
    assert.equal(checkRow(c, item, locks[0].packet, bad).ok, false);
  }
  for (const mutation of [{ channelNonce: 1 }, { sourceAppId: hash(99) }, { destinationChainId: 1 }, { payloadHash: hash(99) }]) {
    assert.notEqual(packetGuid({ ...locks[0].packet, ...mutation }), locks[0].packet.guid);
  }
});

test('ACMP requires canonical receive/process receipts and exact receiver storage', async () => {
  assert.equal((await destinationSnapshot(...fixture())).ok, true);
  for (const change of [{ duplicate: true }, { missing: true }, { failed: true }, { reorg: true },
    { processed: false }, { payload: '0xabcd' }, { latest: 10 }]) {
    assert.equal((await destinationSnapshot(...fixture(change))).ok, false, JSON.stringify(change));
  }
});

test('ACMP source receipt is reconciled with current finalized packet state and all votes', async () => {
  const [c, , , locks, [item]] = fixture();
  c.bridgeUri = 'rho:id:endpoint';
  let corrupt = false;
  const observer = { url: 'test', finalizedBlock: async () => ({ blockNumber: 50, blockHash: 'finalized' }),
    data: async (id, block) => {
      assert.equal(block, 'inclusion');
      return [{ status: 'ok', recordNonce: 0, channelNonce: 0, guid: locks[0].packet.guid }];
    },
    explore: async (term, block) => {
      assert.equal(block, 'finalized');
      if (term.includes('"snapshot"')) return [{ alice: 'yes' }];
      if (term.includes('"outboundNonce"')) return [1];
      return [{ 0: { ...locks[0].packet, sourceDeploy: item.id, payload: corrupt ? '0xff' : item.payload } }];
    } };
  const items = [{ kind: 'vote', voter: 'alice', choice: 'yes' }, item];
  assert.equal((await sourceSnapshot(c, observer, 'rho:id:ballot', items)).ok, true);
  corrupt = true;
  assert.equal((await sourceSnapshot(c, observer, 'rho:id:ballot', items)).ok, false);
});
