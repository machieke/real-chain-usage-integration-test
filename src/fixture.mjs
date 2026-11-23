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
import { ContractFactory, JsonRpcProvider, Wallet, NonceManager, zeroPadValue } from 'ethers';
import { Chain, publicKey, vaultAddress, sleep } from './chain.mjs';
import { allowDestination, bridgeQuery } from './terms.mjs';
import { fundAccounts } from './funding.mjs';
import { trustEndpoint, registerSenders } from './acmp-terms.mjs';
import { renderBridge } from './bridge-deploy.mjs';

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

export async function localFixture({ voters = 1000, bridgeUsers = 10, log = console.log, signal, network } = {}) {
  const root = resolve('.');
  const chainRepo = process.env.CHAIN_REPO ?? resolve(homedir(), 'work/asi/f1r3node-rust');
  const bridgeRepo = process.env.BRIDGE_REPO ?? resolve(homedir(), 'work/takopi/asi-bridge');
  const nodeBinary = process.env.NODE_BINARY ?? resolve(chainRepo, 'target/release/node');
  const nodeImage = process.env.NODE_IMAGE;
  const protocol = process.env.BRIDGE_PROTOCOL ?? 'legacy';
  if (!['legacy', 'acmp'].includes(protocol)) throw new Error('Unsupported bridge protocol');
  const acmp = protocol === 'acmp';
  const oracleImage = process.env.ORACLE_IMAGE;
  const oracleImageId = oracleImage ? (await exec('docker', ['image', 'inspect', oracleImage, '--format', '{{.Id}}'])).stdout.trim() : undefined;
  const oracleBinary = process.env.ORACLE_BINARY ?? resolve('.local/build/debug/oracle');
  const helperBinary = process.env.BRIDGE_HELPER_BINARY ?? resolve('.local/build/debug/deploy_signed_bridge');
  for (const path of [...(network || nodeImage ? [] : [nodeBinary]), ...(oracleImage ? [] : [oracleBinary]), ...(acmp ? [] : [helperBinary])]) {
    try { await access(path); } catch { throw new Error(`Missing ${path}; build the node and run npm run build:bridge`); }
  }
  if (!network && !nodeImage) {
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
  const oracleContainers = [];
  let evm, provider, pool, postgresStarted = false, chainStarted = false, cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    await Promise.all(oracleContainers.map(name => exec('docker', ['stop', '-t', '5', name]).catch(() => {})));
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
  function launchOracle(name, role, env) {
    if (!oracleImageId) return launch(name, oracleBinary, [role], env);
    const container = `${runId}-${name}`;
    oracleContainers.push(container);
    return launch(name, 'docker', ['run', '--rm', '--network', 'host', '--name', container,
      ...Object.keys(env).flatMap(k => ['-e', k]), oracleImageId, role], env);
  }
  try {
    const ports = {};
    for (const name of ['protocol', 'discovery', 'external', 'internal', 'http', 'admin', 'evm', 'postgres']) {
      do { ports[name] = await freePort(); } while (Object.entries(ports).some(([k, v]) => k !== name && v === ports[name]));
    }
    const accounts = network?.accountsFile ? JSON.parse(await readFile(network.accountsFile, 'utf8')) : {
      ownerKey: key(), voterKeys: Array.from({ length: voters }, key), bridgeKeys: Array.from({ length: bridgeUsers }, key),
    };
    const { ownerKey, voterKeys, bridgeKeys } = accounts;
    const validatorKey = key();
    if (voterKeys.length !== voters || bridgeKeys.length !== bridgeUsers) throw new Error('Saved account counts do not match workload');
    const oracleKeys = [key(), key(), key()];
    const evmKey = key();
    let recipients = Array.from({ length: bridgeUsers }, () => new Wallet(`0x${key()}`).address);
    await writeFile(resolve(dir, 'accounts.json'), JSON.stringify({ ownerKey, voterKeys, bridgeKeys }), { mode: 0o600 });
    let node;
    if (!network) {
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
      node = nodeImage ? launch('node', 'docker', ['run', '--rm', '--name', `${runId}-chain`,
        '--network', 'host', '--user', 'root', '-v', `${dir}:${dir}`, '-e', 'RUST_LOG=info',
        '--entrypoint', '/opt/docker/bin/node', nodeImage, ...nodeArgs]) :
        launch('node', nodeBinary, nodeArgs, { RUST_LOG: 'info' });
    }
    const chain = new Chain(network?.chainUrl ?? `http://127.0.0.1:${ports.http}`, { exploreUrl: network?.exploreUrl });
    chain.signal = signal;
    await until(async () => {
      if (signal?.aborted) throw Object.assign(new Error('Fixture startup interrupted'), { fatal: true });
      if (node && (node.exitCode !== null || node.launchError)) throw Object.assign(new Error('Node exited; inspect node.log'), { fatal: true });
      const status = await chain.request('/status');
      return status.isReady && !status.isReadOnly;
    }, 'ASI genesis');
    const status = await chain.request('/status');
    chain.phloEncoding = typeof status.minPhloPrice === 'string' ? 'uint256' : 'legacy';
    chain.maxPhloLimit = status.maxPhloLimit;
    if (network) {
      log(`Using existing ASI network at ${chain.url}; fixture logs: ${dir}`);
      await fundAccounts(chain, network.funderKey, [
        { address: vaultAddress(ownerKey), amount: 10_000_000_000 },
        ...bridgeKeys.map(k => ({ address: vaultAddress(k), amount: 5_000_000_000 })),
        ...voterKeys.map(k => ({ address: vaultAddress(k), amount: 300_000_000 })),
      ], log, resolve(dir, 'funding.jsonl'));
    }
    log('ASI ready; deploying the bridge contracts');
    let id, bridgeUri;
    if (acmp || chain.phloEncoding === 'uint256') {
      const timestamp = Date.now();
      const term = renderBridge(await readFile(resolve(bridgeRepo, acmp ? 'rho-contracts/endpoint.rho' : 'rho-contracts/bridge.rho'), 'utf8'), ownerKey, timestamp);
      const deployed = await chain.deploy(ownerKey, term, { timestamp, shardId: status.shardId,
        phloLimit: 5_000_000_000, validAfterBlockNumber: (await chain.finalizedBlock()).blockNumber });
      id = deployed.id;
      bridgeUri = deployed.data.find(v => typeof v === 'string' && v.startsWith('rho:id:'));
      await writeFile(resolve(dir, 'bridge-deployment.log'), JSON.stringify(deployed, null, 2), { mode: 0o600 });
    } else {
      const bridgeDeployment = await exec(helperBinary, [network?.grpcHost ?? '127.0.0.1',
        String(network?.grpcPort ?? ports.internal), ownerKey,
        resolve(bridgeRepo, 'rho-contracts/bridge.rho')], { timeout: 60_000, maxBuffer: 1024 * 1024, signal })
        .catch(async error => {
          await writeFile(resolve(dir, 'bridge-deployment.log'), (error.stdout ?? '') + (error.stderr ?? ''), { mode: 0o600 });
          throw error;
        });
      await writeFile(resolve(dir, 'bridge-deployment.log'), bridgeDeployment.stdout + bridgeDeployment.stderr, { mode: 0o600 });
      id = bridgeDeployment.stdout.match(/^DEPLOY_ID=(.+)$/m)?.[1];
      bridgeUri = bridgeDeployment.stdout.match(/^BRIDGE_URI=(.+)$/m)?.[1];
    }
    if (!id || !bridgeUri) throw new Error('Signed bridge helper returned no deploy ID/URI');
    await chain.waitFinalized(id);
    if (!acmp) {
      const allowed = await chain.deploy(ownerKey, allowDestination(bridgeUri, 31337), {
        shardId: status.shardId, phloLimit: 100_000_000,
        validAfterBlockNumber: (await chain.finalizedBlock()).blockNumber,
      });
      if (!allowed.data.some(v => v?.status === 'ok')) throw new Error('Bridge destination setup failed');
    }

    signal?.throwIfAborted();
    evm = ganache.server({ logging: { quiet: true }, chain: { chainId: 31337, hardfork: 'shanghai' },
      wallet: { accounts: [{ secretKey: `0x${evmKey}`, balance: '0x3635c9adc5dea00000' }] },
      miner: { blockTime: 1 } });
    await evm.listen(ports.evm, '127.0.0.1');
    provider = new JsonRpcProvider(`http://127.0.0.1:${ports.evm}`, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 200;
    const signer = new NonceManager(new Wallet(`0x${evmKey}`, provider));
    const contractRoot = resolve(bridgeRepo, 'eth-bridge/contracts');
    const files = acmp ? ['ASIEndpoint.sol', 'ASIVerifier.sol', 'examples/ACMPMessageReceiver.sol'] :
      ['ASIChainBridge.sol', 'ASIVerifier.sol', 'test/BridgeTestToken.sol'];
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
    const verifier = await deploy(files[1], 'ASIVerifier');
    await (await verifier.initialize(oracleKeys.map(k => new Wallet(`0x${k}`).address))).wait();
    let token, bridge, sourceApps, sourceEndpointId, destinationEndpointId;
    if (acmp) {
      bridge = await deploy(files[0], 'ASIEndpoint');
      await (await bridge.initialize(await verifier.getAddress(), 2)).wait();
      const [endpointIdentity] = await chain.explore(bridgeQuery(bridgeUri, 'endpointId'),
        (await chain.finalizedBlock()).blockHash);
      if (!/^(0x)?[a-f0-9]{64}$/i.test(endpointIdentity ?? '')) throw new Error('Invalid source endpoint identity');
      sourceEndpointId = `0x${endpointIdentity.replace(/^0x/, '').toLowerCase()}`;
      destinationEndpointId = zeroPadValue(await bridge.getAddress(), 32).toLowerCase();
      await (await bridge.setTrustedEndpoint(0, sourceEndpointId)).wait();
      const trusted = await chain.deploy(ownerKey, trustEndpoint(bridgeUri, 31337, destinationEndpointId), {
        shardId: status.shardId, phloLimit: 100_000_000,
        validAfterBlockNumber: (await chain.finalizedBlock()).blockNumber });
      if (!trusted.data.some(v => v?.status === 'ok')) throw new Error('Endpoint trust setup failed');
      const receivers = [];
      for (let i = 0; i < bridgeUsers; i++) receivers.push(await deploy(files[2], 'ACMPMessageReceiver',
        [await bridge.getAddress(), 0, sourceEndpointId]));
      recipients = await Promise.all(receivers.map(r => r.getAddress()));
      const setup = await chain.deploy(ownerKey, registerSenders(bridgeUri, bridgeKeys,
        recipients.map(r => zeroPadValue(r, 32)), 31337), { shardId: status.shardId, phloLimit: 500_000_000,
        validAfterBlockNumber: (await chain.finalizedBlock()).blockNumber });
      sourceApps = setup.data.filter(v => v?.uri).sort((a, b) => a.user - b.user);
      if (sourceApps.length !== bridgeUsers) throw new Error('Sender registration failed: ' + JSON.stringify(setup.data));
      for (let i = 0; i < bridgeUsers; i++) await (await receivers[i].configure(`0x${sourceApps[i].sourceAppId}`)).wait();
      await writeFile(resolve(dir, 'acmp-setup.json'), JSON.stringify({ sourceEndpointId, destinationEndpointId,
        sourceApps, recipients, setupDeploy: setup.id, trustedDeploy: trusted.id }, null, 2));
    } else {
      token = await deploy(files[2], 'BridgeTestToken', ['Usage test token', 'USAGE', 1_000_000]);
      bridge = await deploy(files[0], 'ASIChainBridge');
      await (await bridge.initialize(await token.getAddress(), await verifier.getAddress(), 2, [0], 8)).wait();
      await (await token.transfer(await bridge.getAddress(), 100_000n * 10n ** 18n)).wait();
      await (await bridge.syncTotalLockedToBalance()).wait();
    }

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
    const env = { DATABASE_URL: databaseUrl, POLL_INTERVAL: '1', LOG_LEVEL: 'info',
      ASI_RPC_NODE: network?.asiRpcNode ?? `127.0.0.1:${ports.internal}:${ports.http}`,
      ASI_OBSERVER_NODE: network?.asiObserverNode ?? `127.0.0.1:${ports.external}`,
      ASI_OBSERVER_HTTP_PORT: String(network?.asiObserverHttpPort ?? new URL(network?.exploreUrl ?? chain.url).port),
      ASI_CHAIN_ID: '0', ETH_RPC_NODE: `http://127.0.0.1:${ports.evm}`, ETH_CHAIN_ID: '31337',
      ETH_PRIVATE_KEY: evmKey, PROOF_THRESHOLD: '2',
      ...(acmp ? { DB_SCHEMA_MODE: 'bootstrap', ASI_ENDPOINT_URI: bridgeUri, ETH_ENDPOINT_ADDRESS: await bridge.getAddress(),
        DESTINATION_CHAINS: '31337:eth', ASI_RECOVERY_START_BLOCK: '0',
        ENDPOINT_DOMAIN_0_ENDPOINT_ID: sourceEndpointId, ENDPOINT_DOMAIN_31337_ENDPOINT_ID: destinationEndpointId } : {
        BRIDGE_SHARED_DECIMALS: '8', ASI_LOCAL_DECIMALS: '8', ASI_BRIDGE_URI: bridgeUri, ASI_START_BLOCK: '0',
        ETH_LOCAL_DECIMALS: '18', ETH_BRIDGE_ADDRESS: await bridge.getAddress(),
        BRIDGE_CONTRACT_ADDRESS: await bridge.getAddress(), BRIDGE_TOKEN_ADDRESS: await token.getAddress(),
        DESTINATION_CHAINS: '31337:eth:18' }) };
    launchOracle('watcher', 'watcher', { ...env, CHAIN: 'asi', CHAIN_ID: '0' });
    launchOracle('finalizer', 'finalizer', { ...env, CHAIN: 'asi', CHAIN_ID: '0' });
    oracleKeys.forEach((k, i) => launchOracle(`verifier-${i + 1}`, 'verifier', {
      ...env, ORACLE_ID: `oracle-${i + 1}`, ORACLE_PRIVATE_KEY: k,
    }));
    launchOracle('relayer', 'relayer', { ...env, CHAIN: 'eth', CHAIN_ID: '31337' });
    await sleep(1500);
    if (children.some(c => c.exitCode !== null || c.launchError)) throw new Error('A fixture process exited; inspect logs');
    const revision = async repo => (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    const nodeImageId = !network && nodeImage ? (await exec('docker', ['image', 'inspect', nodeImage, '--format', '{{.Id}}'])).stdout.trim() : undefined;
    return { config: { protocol, sourceApps, sourceEndpointId, destinationEndpointId, runId, voters, bridgeUsers, ownerKey, voterKeys, bridgeKeys, recipients, bridgeUri,
      phloEncoding: chain.phloEncoding,
      chainUrl: chain.url, observerUrls: network?.observerUrls ?? [chain.url], exploreUrl: network?.exploreUrl, databaseUrl,
      evmUrl: `http://127.0.0.1:${ports.evm}`, evmBridge: await bridge.getAddress(), evmToken: await token?.getAddress(),
      metadata: { topology: network ? 'existing validator network' : 'single-validator dev-mode', chainRevision: await revision(chainRepo),
        bridgeRevision: await revision(bridgeRepo), nodeBinary: network || nodeImage ? undefined : nodeBinary,
        nodeImage: network ? undefined : nodeImage, nodeImageId, nodeVersion: status.version, oracleBinary: oracleImage ? undefined : oracleBinary, oracleImage, oracleImageId, protocol, fixtureLogs: dir,
        chainUrl: chain.url, observerUrls: network?.observerUrls ?? [chain.url], exploreUrl: network?.exploreUrl } }, cleanup, dir };
  } catch (error) {
    await cleanup();
    // execFile errors can include arguments containing keys. Keep diagnostics in private fixture logs.
    if (error.cmd) throw new Error(`Fixture subprocess failed (exit ${error.code}); logs: ${dir}`);
    throw error;
  }
}
