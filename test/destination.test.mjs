import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';
import { bridgeAbi, tokenAbi, destinationSnapshot, proofHash } from '../src/verify.mjs';

function fixture(change = {}) {
  const address = n => `0x${n.toString(16).padStart(40, '0')}`;
  const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
  const c = { evmBridge: address(1), evmToken: address(2), sourceChainId: 0,
    destinationChainId: 31337, evmConfirmations: 2 };
  const item = { id: 'abcd', amount: 10, recipient: address(3) };
  const scale = 10n ** 10n, amount = 10n * scale;
  const digest = proofHash(c, item, 7, amount);
  const bridge = new Interface(bridgeAbi), token = new Interface(tokenAbi);
  const unlock = { ...bridge.encodeEventLog(bridge.getEvent('Unlocked'), [item.recipient, amount, digest, 1000]),
    address: c.evmBridge, blockNumber: 10, blockHash: hash(10), transactionHash: hash(100) };
  const transfer = { ...token.encodeEventLog(token.getEvent('Transfer'), [c.evmBridge, item.recipient, amount]), address: c.evmToken };
  const receipt = { status: 1, blockNumber: 10, blockHash: hash(10), hash: hash(100), to: c.evmBridge, logs: [transfer], ...change.receipt };
  const provider = {
    getBlockNumber: async () => change.latest ?? 12,
    getBlock: async number => ({ hash: change.reorg ? hash(99) : hash(number) }),
    getLogs: async () => change.duplicate ? [unlock, unlock] : [unlock],
    getTransactionReceipt: async () => receipt,
    call: async tx => {
      if (tx.to.toLowerCase() === c.evmBridge) {
        const fn = bridge.parseTransaction(tx).fragment;
        return bridge.encodeFunctionResult(fn, [change.processed ?? true]);
      }
      return token.encodeFunctionResult('balanceOf', [change.balance ?? amount]);
    },
  };
  const rows = [{ location: 'archive', relay_tx_hash: hash(100), source_tx_hash: keccak256('0xabcd'),
    source_chain: '0', destination_chain: '31337',
    params: { asiDeploySig: 'abcd', amount: 10, nonce: 7, destChainId: 31337, recipient: item.recipient } }];
  return [c, provider, rows, [{ id: item.id, nonce: 7, ok: true }], [item],
    { blockNumber: 0, scale, balances: { [item.recipient]: '0' } }];
}

test('destination oracle accepts complete receipt, event, replay and balance evidence', async () => {
  assert.equal((await destinationSnapshot(...fixture())).ok, true);
});

test('archived success cannot mask a failed/reorged/duplicate/unconfirmed destination delivery', async () => {
  for (const change of [{ receipt: { status: 0 } }, { reorg: true }, { duplicate: true },
    { processed: false }, { balance: 0n }, { balance: 200_000_000_000n },
    { receipt: { logs: [] } }, { latest: 10 }, { receipt: { hash: `0x${'f'.repeat(64)}` } }]) {
    assert.equal((await destinationSnapshot(...fixture(change))).ok, false);
  }
});
