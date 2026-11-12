import test from 'node:test';
import assert from 'node:assert/strict';
import { Chain, vaultAddress } from '../src/chain.mjs';
import { sourceSnapshot } from '../src/verify.mjs';

test('receipt reads use inclusion while durable vote/lock state uses the current finalized block', async () => {
  const key = '1'.padStart(64, '0');
  const config = { bridgeUri: 'rho:id:bridge', bridgeKeys: [key], destinationChainId: 31337 };
  const item = { id: 'abcd', kind: 'bridge', amount: 10, recipient: '0xabc', user: 0,
    execution: { blockHash: 'inclusion' } };
  let corrupt = false;
  const observer = {
    url: 'test',
    finalizedBlock: async () => ({ blockHash: 'current', blockNumber: 99 }),
    data: async (id, block) => {
      assert.equal(id, item.id);
      assert.equal(block, 'inclusion');
      return [{ status: 'ok', amount: 10, destChainId: 31337, nonce: 7 }];
    },
    explore: async (term, block) => {
      assert.equal(block, 'current');
      if (term.includes('"snapshot"')) return [{ alice: 'yes' }];
      const fields = { lockAmount: corrupt ? -1 : 10, lockRecipient: '0xabc', lockDest: 31337,
        lockFromAddress: vaultAddress(key) };
      return [Object.entries(fields).find(([method]) => term.includes(`"${method}"`))[1]];
    },
  };
  const items = [{ kind: 'vote', voter: 'alice', choice: 'yes' }, item];
  assert.equal((await sourceSnapshot(config, observer, 'rho:id:ballot', items)).ok, true);
  corrupt = true;
  assert.equal((await sourceSnapshot(config, observer, 'rho:id:ballot', items)).ok, false);
});

test('execution checks share block reads, with fallback when the latest block is a rejection', async () => {
  const chain = new Chain('http://unused');
  let blocks = 0, fallbacks = 0;
  chain.request = async path => {
    if (path.startsWith('/block/')) {
      blocks++;
      return { blockInfo: { blockNumber: 10 }, deploys: [{ sig: 'a', errored: false }, { sig: 'b', errored: false }] };
    }
    fallbacks++;
    return { sig: 'c', blockHash: 'successful-earlier-inclusion' };
  };
  const results = await Promise.all(['a', 'b', 'c'].map(id => chain.execution(id, { latest_block_hash: 'block' })));
  assert.equal(blocks, 1);
  assert.equal(fallbacks, 1);
  assert.equal(results[2].blockHash, 'successful-earlier-inclusion');
});
