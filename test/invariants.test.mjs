import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { keccak256 } from 'ethers';
import { Chain, decodeRho, signDeploy, vaultAddress } from '../src/chain.mjs';
import { makeWorkload, validateConfig, voteDifferences, submitWorkload } from '../src/workload.mjs';
import { checkRow } from '../src/verify.mjs';

const key = i => i.toString(16).padStart(64, '0');
const fixture = () => validateConfig({ ownerKey: key(1),
  voterKeys: Array.from({ length: 1000 }, (_, i) => key(i + 2)),
  bridgeKeys: Array.from({ length: 10 }, (_, i) => key(i + 1002)),
  recipients: Array.from({ length: 10 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`),
  bridgeUri: 'rho:id:bridge' });

test('1000 distinct voters and 10 distinct bridge users submit 100 distinct locks inside one window', () => {
  const c = fixture();
  const items = makeWorkload(c, 'rho:id:ballot', 10, 'root');
  assert.equal(items.length, 1100);
  assert.equal(new Set(items.map(i => i.id)).size, 1100);
  assert.equal(new Set(items.filter(i => i.kind === 'vote').map(i => i.signed.deployer)).size, 1000);
  for (let user = 0; user < 10; user++) {
    assert.equal(items.filter(i => i.kind === 'bridge' && i.user === user).length, 10);
  }
  assert.ok(items.every(i => i.scheduledMs >= 0 && i.scheduledMs < 25_000));
  assert.ok(items.at(-1).scheduledMs > 24_000);
  assert.equal(items.filter(i => i.choice === 'yes').length, 500);
});

test('a matching total count cannot hide a dropped or corrupted vote', () => {
  const expected = [{ kind: 'vote', voter: 'alice', choice: 'yes' }, { kind: 'vote', voter: 'bob', choice: 'no' }];
  assert.equal(voteDifferences(expected, { alice: 'yes', bob: 'no' }).ok, true);
  assert.deepEqual(voteDifferences(expected, { alice: 'yes', mallory: 'no' }), {
    missing: ['bob'], wrong: [], unexpected: ['mallory'], ok: false,
  });
  assert.equal(voteDifferences(expected, { alice: 'no', bob: 'yes' }).ok, false);
});

test('missing, duplicate, unrelayed, and miscorrelated bridge messages cannot pass', () => {
  const c = { sourceChainId: 0, destinationChainId: 31337 };
  const item = { id: 'abcd', amount: 10, recipient: '0x1234' };
  const row = { location: 'archive', relay_tx_hash: `0x${'a'.repeat(64)}`,
    source_tx_hash: keccak256('0xabcd'), source_chain: '0', destination_chain: '31337',
    params: { asiDeploySig: 'abcd', amount: 10, nonce: 7, destChainId: 31337, recipient: '0x1234' } };
  assert.equal(checkRow(c, item, 7, [row]).ok, true);
  for (const rows of [[], [row, row], [{ ...row, location: 'active' }],
    [{ ...row, params: { ...row.params, nonce: 8 } }], [{ ...row, source_tx_hash: `0x${'f'.repeat(64)}` }],
    [{ ...row, params: { ...row.params, recipient: '0x5678' } }]]) {
    assert.equal(checkRow(c, item, 7, rows).ok, false);
  }
});

test('block inclusion or block finality alone cannot satisfy deploy finality', async t => {
  let polls = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('deploy-finalization-status')) {
      res.end(JSON.stringify({ state: ++polls === 1 ? 'Pending' : 'Failed', latestBlockHash: 'finalized-block' }));
    } else { res.end(JSON.stringify({ isFinalized: true, errored: false })); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new Chain(`http://127.0.0.1:${server.address().port}`);
  await assert.rejects(client.waitFinalized('abcd', 5000), /Failed/);
  assert.equal(polls, 2);
});

test('overload is recorded as failure instead of quietly queueing outside the window', async () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ signed: { deployer: 'pk' }, id: String(i), scheduledMs: 0 }));
  const result = await submitWorkload(items, { submit: async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    return 'Success! DeployId is: 0';
  } }, { windowMs: 1000, maxInflight: 1 });
  assert.equal(result.accepted, 1);
  assert.equal(items.filter(i => i.submissionError).length, 4);
});

test('invalid scenario and shared user keys are rejected', () => {
  const c = fixture();
  assert.throws(() => validateConfig({ ...c, windowMs: 31_000 }), /windowMs/);
  assert.throws(() => validateConfig({ ...c, messagesPerUser: 11 }), /messagesPerUser/);
  assert.throws(() => validateConfig({ ...c, bridgeKeys: c.bridgeKeys.map(() => key(2)) }), /distinct/);
});

test('ASI address derivation matches the chain genesis fixture and payloads bind timestamp', () => {
  assert.equal(vaultAddress('5f668a7ee96d944a4494cc947e4005e172d7ab3461ee5538f1f2a45a835e9657'),
    '1111AtahZeefej4tvVR6ti9TJtv8yxLebT31SCEVDCKMNikBk5r3g');
  const a = signDeploy(key(1), 'Nil', { timestamp: 1 });
  const b = signDeploy(key(1), 'Nil', { timestamp: 2 });
  assert.notEqual(a.signature, b.signature);
  assert.deepEqual(signDeploy(key(1), 'Nil', { timestamp: 1 }), a);
  assert.deepEqual(decodeRho({ ExprMap: { data: { voter: { ExprString: { data: 'yes' } } } } }), { voter: 'yes' });
});
