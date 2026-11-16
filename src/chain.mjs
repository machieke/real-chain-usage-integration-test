import { blake2b } from '@noble/hashes/blake2b';
import { secp256k1 } from '@noble/curves/secp256k1';
import bs58 from 'bs58';
import { getBytes, keccak256 } from 'ethers';
import protobuf from 'protobufjs';

// Field numbers and omitted defaults match DeployData::_to_proto in f1r3node-rust.
const DeployData = protobuf.parse(`syntax = "proto3"; message DeployData {
  string term = 2; int64 timestamp = 3; int64 phloPrice = 7;
  int64 phloLimit = 8; int64 validAfterBlockNumber = 10; string shardId = 11;
}`).root.lookupType('DeployData');
const DeployData256 = protobuf.parse(`syntax = "proto3"; message DeployData {
  string term = 2; int64 timestamp = 3; int64 phloLimit = 8;
  int64 validAfterBlockNumber = 10; string shardId = 11; bytes phloPrice = 15;
}`).root.lookupType('DeployData');

export const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
export const hex = bytes => Buffer.from(bytes).toString('hex');
export const publicKey = key => hex(secp256k1.getPublicKey(key.replace(/^0x/, ''), false));

export function vaultAddress(key) {
  const eth = getBytes(keccak256(getBytes(`0x${publicKey(key).slice(2)}`))).slice(-20);
  const payload = Buffer.concat([Buffer.alloc(4), getBytes(keccak256(eth))]);
  return bs58.encode(Buffer.concat([payload, blake2b(payload, { dkLen: 32 }).slice(0, 4)]));
}

export function signDeploy(key, term, { timestamp = Date.now(), phloLimit = 100_000_000,
  phloPrice = 1, validAfterBlockNumber = 0, shardId = 'root', phloEncoding = 'legacy' } = {}) {
  if (!['legacy', 'uint256'].includes(phloEncoding)) throw new Error('Unknown phlo encoding');
  const amount = BigInt(phloPrice);
  if (amount < 0n || amount >= 1n << 256n) throw new Error('Phlo price outside uint256');
  if (phloEncoding === 'uint256') phloPrice = String(amount);
  const data = { term, timestamp, phloPrice, phloLimit, validAfterBlockNumber, shardId };
  const wire = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== 0 && v !== ''));
  const schema = phloEncoding === 'uint256' ? DeployData256 : DeployData;
  if (phloEncoding === 'uint256') wire.phloPrice = Buffer.from(amount.toString(16).padStart(64, '0'), 'hex');
  const digest = blake2b(schema.encode(schema.fromObject(wire)).finish(), { dkLen: 32 });
  const signature = secp256k1.sign(digest, key.replace(/^0x/, ''), { lowS: true }).toDERHex();
  return { data, deployer: publicKey(key), signature, sigAlgorithm: 'secp256k1' };
}

export function decodeRho(expr) {
  const entries = Object.entries(expr);
  if (entries.length !== 1) throw new Error('Malformed Rholang expression');
  const [tag, value] = entries[0];
  if (tag === 'ExprBigInt' || tag === 'ExprInt') {
    const number = Number(value.data);
    return Number.isSafeInteger(number) ? number : String(value.data);
  }
  if (['ExprString', 'ExprUri', 'ExprBool', 'ExprBytes'].includes(tag)) return value.data;
  if (['ExprList', 'ExprTuple', 'ExprSet', 'ExprPar'].includes(tag)) return value.data.map(decodeRho);
  if (tag === 'ExprMap') return Object.fromEntries(Object.entries(value.data).map(([k, v]) => {
    return [k.startsWith('"') ? JSON.parse(k) : k, decodeRho(v)];
  }));
  throw new Error(`Unsupported Rholang value: ${tag}`);
}

export class Chain {
  constructor(url, { timeoutMs = 15_000, exploreUrl } = {}) {
    this.url = url.replace(/\/$/, '');
    this.exploreUrl = exploreUrl?.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.blocks = new Map();
  }
  async request(path, body, timeoutMs = this.timeoutMs) {
    const exploratory = path.startsWith('/explore-deploy');
    // Read retries may wait for the observer's execution slot. Deploy writes
    // are never retried: their admission remains bounded by the load window.
    const end = Math.min(this.deadline ?? Infinity, performance.now() + (exploratory ? 60_000 : timeoutMs));
    while (true) {
      this.signal?.throwIfAborted();
      const remaining = end - performance.now();
      if (remaining <= 0) throw new Error('Request or completion deadline exceeded');
      const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(timeoutMs, remaining))));
      const base = exploratory ? this.exploreUrl ?? this.url : this.url;
      const response = await fetch(`${base}/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
      });
      const result = await response.json();
      if (exploratory && response.status === 503 && result.error === 'observer_busy') {
        const seconds = Number(response.headers?.get('retry-after') ?? 15);
        const delay = Number.isFinite(seconds) && seconds >= 0 ? Math.max(10, seconds * 1000) : 15_000;
        if (performance.now() + delay >= end) throw new Error('Observer busy beyond request or completion deadline');
        // Short waits keep shutdown responsive, including during fixture setup.
        const retryAt = performance.now() + delay;
        while (performance.now() < retryAt) {
          this.signal?.throwIfAborted();
          await sleep(Math.min(250, retryAt - performance.now()));
        }
        continue;
      }
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${JSON.stringify(result)}`);
      return result;
    }
  }

  submit(signed, timeoutMs) { return this.request('/deploy', signed, timeoutMs); }
  status(id) { return this.request(`/deploy-finalization-status/${id}`); }
  detail(id) { return this.request(`/deploy/${id}`); }
  async execution(id, status) {
    const hash = status.latest_block_hash ?? status.latestBlockHash;
    if (!hash) return this.detail(id);
    if (!this.blocks.has(hash)) {
      const promise = this.request(`/block/${hash}?view=full`);
      this.blocks.set(hash, promise);
      promise.catch(() => this.blocks.delete(hash));
    }
    const block = await this.blocks.get(hash);
    const deploy = block.deploys?.find(d => d.sig === id && !d.errored);
    // latest_block_hash can identify a rejection instead of the successful inclusion.
    if (!deploy) return this.detail(id);
    return { ...deploy, blockHash: hash, blockNumber: block.blockInfo?.blockNumber ?? block.blockNumber };
  }
  async finalizedBlock() {
    const block = await this.request('/last-finalized-block?view=summary');
    return block.blockInfo ?? block;
  }
  async data(id, blockHash) {
    const result = await this.request('/data-at-name-by-block-hash', {
      name: { UnforgDeploy: { data: id } }, blockHash, usePreStateHash: false,
    });
    return result.expr.map(decodeRho);
  }
  async explore(term, blockHash) {
    const result = await this.request('/explore-deploy-by-block-hash', {
      term, blockHash, usePreStateHash: false,
    });
    return result.expr.map(decodeRho);
  }
  async waitFinalized(id, timeoutMs = 180_000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const status = await this.status(id);
      if (status.state === 'Finalized') return this.execution(id, status);
      if (['Failed', 'Expired'].includes(status.state)) throw new Error(`Deploy ${id}: ${status.state}`);
      await sleep(1000);
    }
    throw new Error(`Deploy ${id} did not finalize in ${timeoutMs}ms`);
  }
  async deploy(key, term, options = {}) {
    const signed = signDeploy(key, term, { phloEncoding: this.phloEncoding ?? 'legacy', ...options });
    await this.submit(signed);
    const detail = await this.waitFinalized(signed.signature);
    if (detail.errored || detail.systemDeployError) throw new Error(`Deploy execution failed: ${signed.signature}`);
    return { id: signed.signature, detail, data: await this.data(signed.signature, detail.blockHash) };
  }
}
