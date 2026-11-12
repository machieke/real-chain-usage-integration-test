import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, access, open } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import ganache from 'ganache';
import solc from 'solc';
import pg from 'pg';
import { ContractFactory, JsonRpcProvider, Wallet, NonceManager } from 'ethers';
import { Chain, publicKey, vaultAddress, sleep } from './chain.mjs';
import { allowDestination } from './terms.mjs';

const exec = promisify(execFile);
const key = () => randomBytes(32).toString('hex');
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolvePort(port));
  });
});

async function until(fn, label, timeoutMs = 180_000) {
  const deadline = performance.now() + timeoutMs;
  let last;
  while (performance.now() < deadline) {
    try { if (await fn()) return; } catch (error) {
      if (error.fatal) throw error;
      last = error.message;
    }
    await sleep(1000);
  }
  throw new Error(`${label} timed out: ${last ?? 'not ready'}`);
}

export async function localFixture({ voters = 1000, bridgeUsers = 10, log = console.log, signal } = {}) {
  const root = resolve('.');
  const chainRepo = process.env.CHAIN_REPO ?? resolve(homedir(), 'work/asi/f1r3node-rust');
  const bridgeRepo = process.env.BRIDGE_REPO ?? resolve(homedir(), 'work/takopi/asi-bridge');
  const nodeBinary = process.env.NODE_BINARY ?? resolve(chainRepo, 'target/release/node');
  const nodeImage = process.env.NODE_IMAGE;
  const oracleBinary = process.env.ORACLE_BINARY ?? resolve('.local/build/debug/oracle');
  const helperBinary = process.env.BRIDGE_HELPER_BINARY ?? resolve('.local/build/debug/deploy_signed_bridge');
  for (const path of [...(nodeImage ? [] : [nodeBinary]), oracleBinary, helperBinary]) {
    try { await access(path); } catch { throw new Error(`Missing ${path}; build the node and run npm run build:bridge`); }
  }
  if (!nodeImage) {
    const handle = await open(nodeBinary, 'r');
    try {
      const { buffer } = await handle.read(Buffer.alloc(2), 0, 2, 0);
      if (buffer.toString() === '#!') throw new Error('NODE_BINARY points to a wrapper. Set a native executable or NODE_IMAGE so fixture paths are mounted explicitly.');
    } finally { await handle.close(); }
  }
  const runId = `usage-${randomUUID()}`;
  const dir = resolve('.local', runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const children = [];
  let evm, provider, pool, postgresStarted = false, chainStarted = false, cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    if (chainStarted) await exec('docker', ['stop', '-t', '5', `${runId}-chain`]).catch(() => {});
    for (const child of children.toReversed()) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await Promise.all(children.map(child => child.exitCode !== null ? undefined : new Promise(resolveExit => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolveExit(); }, 5000);
      child.once('exit', () => { clearTimeout(timeout); resolveExit(); });
    })));
    await pool?.end();
    provider?.destroy();
    await evm?.close();
    if (postgresStarted) {
      const logs = await exec('docker', ['logs', runId]).catch(() => ({ stdout: '', stderr: '' }));
      await writeFile(resolve(dir, 'postgres.log'), logs.stdout + logs.stderr);
      await exec('docker', ['rm', '-f', runId]);
    }
  })();
  function launch(name, binary, args, env = {}) {
    signal?.throwIfAborted();
    const fd = openSync(resolve(dir, `${name}.log`), 'a', 0o600);
    const child = spawn(binary, args, { env: { ...process.env, ...env }, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    children.push(child);
    child.on('error', error => { child.launchError = error; });
    return child;
  }
  try {
    const ports = {};
    for (const name of ['protocol', 'discovery', 'external', 'internal', 'http', 'admin', 'evm', 'postgres']) {
      do { ports[name] = await freePort(); } while (Object.entries(ports).some(([k, v]) => k !== name && v === ports[name]));
    }
    const ownerKey = key(), validatorKey = key(), voterKeys = Array.from({ length: voters }, key);
    const bridgeKeys = Array.from({ length: bridgeUsers }, key);
    const oracleKeys = [key(), key(), key()];
    const evmKey = key();
    const recipients = Array.from({ length: bridgeUsers }, () => new Wallet(`0x${key()}`).address);
    const configPath = resolve(dir, 'node.conf');
    const chainConfig = await readFile(resolve(chainRepo, 'docker/conf/standalone-dev.conf'), 'utf8');
    await writeFile(configPath, `${chainConfig}\ncasper.validator-private-key = "${validatorKey}"\napi-server.host = "127.0.0.1"\n`, { mode: 0o600 });
    await writeFile(resolve(dir, 'bonds.txt'), `${publicKey(validatorKey)} 100000000000\n`);
    await writeFile(resolve(dir, 'wallets.txt'), [ownerKey, validatorKey, ...voterKeys, ...bridgeKeys]
      .map(k => `${vaultAddress(k)},1000000000000`).join('\n') + '\n');
    log(`Starting isolated ASI node; logs: ${dir}`);
    const nodeArgs = ['--log-sink=stdout', 'run', '-s', '--host=127.0.0.1',
      '--allow-private-addresses', `--config-file=${configPath}`, `--data-dir=${resolve(dir, 'node')}`,
      `--bonds-file=${resolve(dir, 'bonds.txt')}`, `--wallets-file=${resolve(dir, 'wallets.txt')}`,
      `--protocol-port=${ports.protocol}`, `--discovery-port=${ports.discovery}`,
      `--api-port-grpc-external=${ports.external}`, `--api-port-grpc-internal=${ports.internal}`,
      `--api-port-http=${ports.http}`, `--api-port-admin-http=${ports.admin}`];
    chainStarted = Boolean(nodeImage);
    const node = nodeImage ? launch('node', 'docker', ['run', '--rm', '--name', `${runId}-chain`,
      '--network', 'host', '--user', 'root', '-v', `${dir}:${dir}`, '-e', 'RUST_LOG=info',
      '--entrypoint', '/opt/docker/bin/node', nodeImage, ...nodeArgs]) :
      launch('node', nodeBinary, nodeArgs, { RUST_LOG: 'info' });
    const chain = new Chain(`http://127.0.0.1:${ports.http}`);
    chain.signal = signal;
    await until(async () => {
      if (signal?.aborted) throw Object.assign(new Error('Fixture startup interrupted'), { fatal: true });
      if (node.exitCode !== null || node.launchError) throw Object.assign(new Error('Node exited; inspect node.log'), { fatal: true });
      const status = await chain.request('/status');
      return status.isReady && !status.isReadOnly;
    }, 'ASI genesis');
    log('ASI genesis ready; deploying the bridge contracts');
    const status = await chain.request('/status');
    const bridgeDeployment = await exec(helperBinary, ['127.0.0.1', String(ports.internal), ownerKey,
      resolve(bridgeRepo, 'rho-contracts/bridge.rho')], { timeout: 60_000, maxBuffer: 1024 * 1024, signal });
    await writeFile(resolve(dir, 'bridge-deployment.log'), bridgeDeployment.stdout + bridgeDeployment.stderr, { mode: 0o600 });
    const id = bridgeDeployment.stdout.match(/^DEPLOY_ID=(.+)$/m)?.[1];
    const bridgeUri = bridgeDeployment.stdout.match(/^BRIDGE_URI=(.+)$/m)?.[1];
    if (!id || !bridgeUri) throw new Error('Signed bridge helper returned no deploy ID/URI');
    await chain.waitFinalized(id);
    const allowed = await chain.deploy(ownerKey, allowDestination(bridgeUri, 31337), {
      shardId: status.shardId, phloLimit: 100_000_000,
      validAfterBlockNumber: (await chain.finalizedBlock()).blockNumber,
    });
    if (!allowed.data.some(v => v?.status === 'ok')) throw new Error('Bridge destination setup failed');

    signal?.throwIfAborted();
    evm = ganache.server({ logging: { quiet: true }, chain: { chainId: 31337, hardfork: 'shanghai' },
      wallet: { accounts: [{ secretKey: `0x${evmKey}`, balance: '0x3635c9adc5dea00000' }] },
      miner: { blockTime: 1 } });
    await evm.listen(ports.evm, '127.0.0.1');
    provider = new JsonRpcProvider(`http://127.0.0.1:${ports.evm}`, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 200;
    const signer = new NonceManager(new Wallet(`0x${evmKey}`, provider));
    const contractRoot = resolve(bridgeRepo, 'eth-bridge/contracts');
    const files = ['ASIChainBridge.sol', 'ASIVerifier.sol', 'test/BridgeTestToken.sol'];
    const sources = Object.fromEntries(await Promise.all(files.map(async file => [file,
      { content: await readFile(resolve(contractRoot, file), 'utf8') }])));
    const { readFileSync } = await import('node:fs');
    const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources,
      settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }), {
      import: path => {
        try { return { contents: readFileSync(resolve(path.startsWith('@') ? resolve(root, 'node_modules') : contractRoot, path), 'utf8') }; }
        catch { return { error: `Import not found: ${path}` }; }
      },
    }));
    const errors = compiled.errors?.filter(e => e.severity === 'error');
    if (errors?.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
    const deploy = async (file, name, args = []) => {
      signal?.throwIfAborted();
      const artifact = compiled.contracts[file][name];
      const contract = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer).deploy(...args);
      await contract.waitForDeployment();
      return contract;
    };
    const token = await deploy(files[2], 'BridgeTestToken', ['Usage test token', 'USAGE', 1_000_000]);
    const verifier = await deploy(files[1], 'ASIVerifier');
    const bridge = await deploy(files[0], 'ASIChainBridge');
    await (await verifier.initialize(oracleKeys.map(k => new Wallet(`0x${k}`).address))).wait();
    await (await bridge.initialize(await token.getAddress(), await verifier.getAddress(), 2, [0], 8)).wait();
    await (await token.transfer(await bridge.getAddress(), 100_000n * 10n ** 18n)).wait();
    await (await bridge.syncTotalLockedToBalance()).wait();

    signal?.throwIfAborted();
    const password = randomBytes(24).toString('hex');
    await exec('docker', ['run', '-d', '--name', runId,
      '-p', `127.0.0.1:${ports.postgres}:5432`, '-e', 'POSTGRES_USER=oracle', '-e', 'POSTGRES_DB=oracle',
      '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:16-alpine']);
    postgresStarted = true;
    const databaseUrl = `postgresql://oracle:${password}@127.0.0.1:${ports.postgres}/oracle`;
    pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000, statement_timeout: 10_000 });
    await until(async () => {
      if (signal?.aborted) throw Object.assign(new Error('Fixture startup interrupted'), { fatal: true });
      return (await pool.query('SELECT 1')).rowCount === 1;
    }, 'PostgreSQL', 60_000);
    await pool.query(await readFile(resolve(bridgeRepo, 'asi-oracle-rs/asi-bridge-db/schema.sql'), 'utf8'));
    const env = { DATABASE_URL: databaseUrl, BRIDGE_SHARED_DECIMALS: '8', POLL_INTERVAL: '1',
      LOG_LEVEL: 'info', ASI_LOCAL_DECIMALS: '8', ASI_BRIDGE_URI: bridgeUri, ASI_START_BLOCK: '0',
      ASI_RPC_NODE: `127.0.0.1:${ports.internal}:${ports.http}`,
      ASI_OBSERVER_NODE: `127.0.0.1:${ports.external}`, ASI_CHAIN_ID: '0',
      ETH_RPC_NODE: `http://127.0.0.1:${ports.evm}`, ETH_LOCAL_DECIMALS: '18', ETH_CHAIN_ID: '31337',
      ETH_BRIDGE_ADDRESS: await bridge.getAddress(), BRIDGE_CONTRACT_ADDRESS: await bridge.getAddress(),
      BRIDGE_TOKEN_ADDRESS: await token.getAddress(), ETH_PRIVATE_KEY: evmKey,
      DESTINATION_CHAINS: '31337:eth:18', PROOF_THRESHOLD: '2' };
    launch('watcher', oracleBinary, ['watcher'], { ...env, CHAIN: 'asi', CHAIN_ID: '0' });
    launch('finalizer', oracleBinary, ['finalizer'], { ...env, CHAIN: 'asi', CHAIN_ID: '0' });
    oracleKeys.forEach((k, i) => launch(`verifier-${i + 1}`, oracleBinary, ['verifier'], {
      ...env, ORACLE_ID: `oracle-${i + 1}`, ORACLE_PRIVATE_KEY: k,
    }));
    launch('relayer', oracleBinary, ['relayer'], { ...env, CHAIN: 'eth', CHAIN_ID: '31337' });
    await sleep(1500);
    if (children.some(c => c.exitCode !== null || c.launchError)) throw new Error('A fixture process exited; inspect logs');
    const revision = async repo => (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    const nodeImageId = nodeImage ? (await exec('docker', ['image', 'inspect', nodeImage, '--format', '{{.Id}}'])).stdout.trim() : undefined;
    return { config: { voters, bridgeUsers, ownerKey, voterKeys, bridgeKeys, recipients, bridgeUri,
      chainUrl: chain.url, observerUrls: [chain.url], databaseUrl,
      evmUrl: `http://127.0.0.1:${ports.evm}`, evmBridge: await bridge.getAddress(), evmToken: await token.getAddress(),
      metadata: { topology: 'single-validator dev-mode', chainRevision: await revision(chainRepo),
        bridgeRevision: await revision(bridgeRepo), nodeBinary: nodeImage ? undefined : nodeBinary,
        nodeImage, nodeImageId, nodeVersion: status.version, oracleBinary, fixtureLogs: dir } }, cleanup, dir };
  } catch (error) {
    await cleanup();
    // execFile errors can include arguments containing keys. Keep diagnostics in private fixture logs.
    if (error.cmd) throw new Error(`Fixture subprocess failed (exit ${error.code}); logs: ${dir}`);
    throw error;
  }
}
