import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fundAccounts } from '../src/funding.mjs';

test('funding splits at the node budget and verifies every recipient in the final partial batch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'asi-funding-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const accounts = ['alice', 'bob', 'carol', 'dan', 'eve'].map(address => ({ address, amount: 100 }));
  const batches = [accounts.slice(0, 2), accounts.slice(2, 4), accounts.slice(4)];
  let calls = 0;
  const chain = {
    maxPhloLimit: 2_000_000,
    request: async () => ({ shardId: 'root' }),
    finalizedBlock: async () => ({ blockHash: 'block', blockNumber: 100 }),
    explore: async () => [Object.fromEntries(accounts.map(a => [a.address, 0]))],
    deploy: async (key, term, options) => {
      assert.equal(options.phloLimit, 2_000_000);
      const batch = batches[calls++];
      for (const a of accounts) assert.equal(term.includes(`"${a.address}"`), batch.includes(a));
      return { id: String(calls), detail: { cost: 1_000_000 }, data: [Object.fromEntries(batch.map(a => [a.address, a.amount]))] };
    },
  };
  const journal = join(dir, 'funding.jsonl');
  await fundAccounts(chain, '1'.padStart(64, '0'), accounts, () => {}, journal);
  assert.equal(calls, 3);
  const records = (await readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.flatMap(r => r.accounts), accounts);
  assert.deepEqual(records.map(r => r.phloLimit), [2_000_000, 2_000_000, 2_000_000]);
});
