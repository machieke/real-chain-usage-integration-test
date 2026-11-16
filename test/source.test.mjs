import test from 'node:test';
import assert from 'node:assert/strict';
import { Chain, decodeRho, vaultAddress } from '../src/chain.mjs';
import { sourceSnapshot } from '../src/verify.mjs';

test('BigInt values retain exact balances and safe lock amounts', () => {
  assert.equal(decodeRho({ ExprBigInt: { data: '100000000' } }), 100000000);
  assert.equal(decodeRho({ ExprBigInt: { data: '50000000000000001' } }), '50000000000000001');
  assert.equal(decodeRho({ ExprInt: { data: '31337' } }), 31337);
});

test('observer exploration preserves the validator block hash and deploy reads stay on the validator', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: options.body && JSON.parse(options.body) });
    return { ok: true, json: async () => ({ expr: [] }) };
  });
  const chain = new Chain('http://validator', { exploreUrl: 'http://readonly' });
  await chain.explore('Nil', 'validator-finalized-hash');
  await chain.data('deploy-id', 'inclusion');
  assert.equal(calls[0].url, 'http://readonly/api/explore-deploy-by-block-hash');
  assert.equal(calls[0].body.blockHash, 'validator-finalized-hash');
  assert.equal(calls[1].url, 'http://validator/api/data-at-name-by-block-hash');
});

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

test('observer admission retries preserve the requested snapshot and never retry deploy writes', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: options.body });
    const busy = url.endsWith('/deploy') || calls.length === 1;
    return { ok: !busy, status: busy ? 503 : 200, headers: { get: () => '0' },
      json: async () => busy ? { error: 'observer_busy' } : { expr: [] } };
  });
  const chain = new Chain('http://validator', { exploreUrl: 'http://readonly' });
  await chain.explore('Nil', 'fixed-finalized-hash');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  await assert.rejects(chain.submit({ signature: 'id' }), /HTTP 503/);
  assert.equal(calls.length, 3);
});

test('observer backoff cannot extend the completion deadline', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503,
    headers: { get: () => '15' }, json: async () => ({ error: 'observer_busy' }) }));
  const chain = new Chain('http://readonly');
  chain.deadline = performance.now() + 500;
  await assert.rejects(chain.explore('Nil', 'block'), /Observer busy beyond/);
});

test('a failed read batch drains in-flight operations and admits no more work', async () => {
  const { mapLimit } = await import('../src/workload.mjs');
  let started = [], release;
  const blocked = new Promise(resolve => { release = resolve; });
  let settled = false;
  const result = mapLimit([0, 1, 2, 3], 2, async i => {
    started.push(i);
    if (i === 0) throw new Error('observer busy');
    await blocked;
  }).catch(error => { settled = true; return error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1]);
  release();
  assert.match((await result).message, /observer busy/);
  assert.deepEqual(started, [0, 1]);
});
