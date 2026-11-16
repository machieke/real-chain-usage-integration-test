# Real ASI:chain usage integration test

A Rholang ballot receives one vote from each of **1,000 distinct users** while **10 other users each submit 10 ASI bridge messages**, all paced across **25 seconds**. The destination is a local EVM chain running the real Solidity contracts. The harness supports ACMP opaque messages and the older token lock/unlock protocol. The real Rust watcher, finalizer, three verifiers, and relayer process the messages through PostgreSQL.

The 20–30 second requirement applies to submission, not finalization. Every request must start inside the configured window and receive its own deploy-ID acknowledgement within 30 seconds of the shared start. The test then allows 15 minutes for convergence. A dropped request, deploy, vote, or bridge message fails the run; the harness does not resubmit it under a new identity.

## Run locally

Requirements: Node.js 22+, Docker, the built `f1r3node-rust` node, and the Rust toolchain/system dependencies required by `asi-bridge` (including protobuf and OpenSSL). The bridge build requires x86 AES/SSE2, matching its `gxhash` dependency.

```bash
npm ci
npm run build:bridge
npm test
npm run test:local
```

Default source checkouts:

- `CHAIN_REPO=$HOME/work/asi/f1r3node-rust`
- `BRIDGE_REPO=$HOME/work/takopi/asi-bridge`

Override those variables or `NODE_BINARY`, `ORACLE_BINARY`, and `BRIDGE_HELPER_BINARY`. The bridge build uses its committed Cargo lockfile and the pinned nightly toolchain, writing build output under this repository's `.local/` directory. The local fixture compiles the EVM contracts from the supplied bridge checkout and deploys the unchanged signed Rholang bridge template using its own helper.

Each invocation creates fresh keys, funded genesis wallets, a fresh ASI standalone node, a fresh EVM chain, and a dedicated PostgreSQL container on dynamically allocated loopback ports. It leaves source checkouts untouched. On exit it stops its own processes and removes its PostgreSQL container. Node data and service logs remain under `.local/usage-*`; those files include local fixture secrets and must not be shared. This is a single-validator baseline; use a multi-validator network for merge/fork and replica convergence coverage.

For a Docker node, set `NODE_IMAGE` explicitly. The fixture mounts its config and genesis files into that image and owns the container lifecycle. It rejects a `NODE_BINARY` that is a shell wrapper because an arbitrary wrapper may not mount those files. For example, with an image already built from the chain project:

```bash
NODE_IMAGE=f1r3fly-rust:YOUR_BUILD_TAG npm run test:local
```

```bash
# Wiring smoke test; this is NOT evidence for the 1000-voter requirement.
VOTERS=20 MESSAGES_PER_USER=5 npm run test:local

# Full load with 5 locks per bridge user and a 20-second window.
WINDOW_MS=20000 MESSAGES_PER_USER=5 npm run test:local
```

Final verification reads source history in sequential batches of ten packets and honors the observer's `503 observer_busy` / `Retry-After` response. Read retries stay inside the completion deadline; signed workload deploys are never retried.

`COMPLETION_TIMEOUT_MS` overrides the 15-minute drain deadline. The exit status is 0 only on a complete pass.

## Current ACMP bridge builds

For the current `asi-bridge` endpoint architecture, use `BRIDGE_PROTOCOL=acmp`. Set `ORACLE_IMAGE` to your newly built oracle image; the harness resolves its immutable image ID and runs the watcher, finalizer, three verifiers, and relayer from that exact image. It compiles the unchanged EVM endpoint/verifier/receiver contracts from `BRIDGE_REPO` and deploys the unchanged signed Rholang `endpoint.rho` template.

```bash
NETWORK_CONFIG=/secure/path/network.json \
BRIDGE_PROTOCOL=acmp \
ORACLE_IMAGE=alejandrocorona/bridge-test:dev \
npm run test:local
```

Setup creates ten Rholang sender applications and ten EVM `ACMPMessageReceiver` instances. Each sender holds its private endpoint capability and authenticates its designated user's system deployer capability. Each payload identifies its run, user, and message. The source application records the signed ASI deploy ID using the endpoint's `setSourceDeploy` operation. This tests the real message transport; it does not test token custody or decimal conversion.

ACMP runs apply the same submission, deploy-finality, vote-map, and stability requirements below. In place of lock/unlock checks, they require:

- Exactly 100 source packet records, with unique global nonces and GUIDs, complete per-application channel nonces, exact payloads and routes, and the correct source deploy IDs. GUIDs and payload hashes are recomputed independently.
- Exactly one archived oracle row per message and no active or unexpected rows; every canonical packet field must match the finalized source record.
- Exactly one canonical, successful `PacketReceived` transaction and one `PacketProcessed` transaction per message, each with two confirmations. The endpoint header, received/processed flags, and receiver's stored payload must match exactly.

`ORACLE_IMAGE` containers use host networking for the existing localhost ASI APIs and the isolated local EVM/PostgreSQL services. Cleanup stops only containers owned by this run. If the observer gRPC and HTTP ports are not consecutive, set `asiObserverHttpPort` explicitly in the private network JSON (the local configuration uses `40453`). By default the HTTP port is read from `exploreUrl`.

The default protocol remains `legacy` for the earlier bridge checkout. Its token-specific criteria and example configuration below apply only to that mode.

## Pass criteria

1. All expected signed deploy IDs are acknowledged within the submission deadline. Requests are paced independently of chain progress; load-generator saturation is a failure.
2. Every deploy reaches the node's **deploy-level `Finalized` state**, with no execution error. Block inclusion or block finality is insufficient because merge rejection can discard individual deploy effects.
3. Every configured observer's finalized snapshot contains exactly the expected voter-address → choice map, with no missing, wrong, or extra entries. The ballot serializes updates through private state and rejects repeat votes; callers supply the system deployer capability.
4. Every lock has exactly one successful deploy result at its inclusion block and matching current finalized nonce history (amount, destination, recipient, and sender). The deploy-result API is event-indexed, so receipts must be read at inclusion; durable history is checked at the current finalized snapshot. No two messages share a nonce. Observers agree on lock identities and nonces.
5. Every source deploy maps to exactly one archived bridge row and no active queue row, with matching source/destination IDs, payload, source signature, and source transaction hash.
6. Every archived relay has a successful canonical EVM receipt with at least two confirmations, exactly one matching `Unlocked` event, the correct ERC-20 transfer, and both replay-protection flags set. Recipient balance deltas equal the exact expected amounts, accounting for 8 → 18 decimal conversion.
7. The complete state remains correct for at least 10 seconds and across a later finalized block on every source observer.

This establishes bounded eventual convergence for this workload. It does not prove consistency for arbitrary executions, and a standalone run does not test multi-validator conflict recovery.

## Existing networks

To provision fresh test accounts and the bridge pipeline on an already-running ASI development network, set `NETWORK_CONFIG` to a private JSON file and run `npm run test:local`. The existing nodes remain running when the test ends. Funding and setup finish before the timed workload starts.

```json
{
  "chainUrl": "http://127.0.0.1:40413",
  "observerUrls": ["http://127.0.0.1:40403", "http://127.0.0.1:40413", "http://127.0.0.1:40423", "http://127.0.0.1:40433", "http://127.0.0.1:40453"],
  "exploreUrl": "http://127.0.0.1:40453",
  "grpcHost": "127.0.0.1",
  "grpcPort": 40412,
  "asiRpcNode": "127.0.0.1:40412:40413",
  "asiObserverNode": "127.0.0.1:40451",
  "funderKey": "FUNDED_DEVELOPMENT_ACCOUNT_PRIVATE_KEY"
}
```

`exploreUrl` routes exploratory queries to the read-only node, using the exact finalized block hash reported by each configured node. Receipts are still read from each node. Reports record both endpoints; this checks agreement of their canonical finalized histories, with state execution queried on the read-only replica.

The fixture detects the chain's phlo-price format from `/status`, supporting legacy integers and the current decimal-string / 32-byte protobuf encoding. For the latter it signs and submits the original bridge template over HTTP, using the registry signature format from `rust-client`. Fresh account keys are retained privately under `.local/usage-*/accounts.json`. Set `accountsFile` in the network configuration to resume interrupted setup with those keys; funding checks finalized balances and transfers only a deficit. Default funding is 3 ASI per voter, 50 per bridge user, and 100 for the owner, plus the funder's transaction fees.

Provide a private JSON configuration, with **already-funded distinct ASI keys**, a configured bridge and working oracle services, and dedicated EVM recipient addresses. Do not use shared recipients receiving unrelated transfers during a run. The runner deploys a fresh ballot and submits real transactions using the supplied accounts.

```bash
npm run test:live -- /secure/path/usage-config.json
```

```json
{
  "chainUrl": "http://127.0.0.1:40413",
  "observerUrls": ["http://127.0.0.1:40453"],
  "databaseUrl": "postgresql://oracle:PASSWORD@127.0.0.1:5432/oracle",
  "bridgeUri": "rho:id:REPLACE_WITH_ACTUAL_LOWERCASE_URI",
  "evmUrl": "http://127.0.0.1:8545",
  "evmBridge": "0xREPLACE",
  "evmToken": "0xREPLACE",
  "sourceChainId": 0,
  "destinationChainId": 31337,
  "ownerKey": "64_HEX_DIGITS",
  "voterKeys": ["1000_DISTINCT_FUNDED_PRIVATE_KEYS"],
  "bridgeKeys": ["10_DISTINCT_FUNDED_PRIVATE_KEYS"],
  "recipients": ["10_EVM_RECIPIENT_ADDRESSES"],
  "messagesPerUser": 10,
  "windowMs": 25000,
  "completionTimeoutMs": 900000
}
```

The defaults use a phlo price of 1 and a 100,000,000 phlo limit per workload deploy. Each bridge lock transfers 100,000,000 raw ASI units (1 ASI). Fund each signer for deploy precharges and bridge amounts; provide enough destination liquidity. Source and shared decimals are 8. All configured observers must support exploratory reads at explicit finalized block hashes and the submit node must expose `/api/deploy-finalization-status`.

## Evidence

Each run writes `artifacts/<run>/manifest.json`, `signed-deploys.json`, `events.jsonl`, and `report.json`. These contain public signed deploy payloads, public keys, deploy IDs, schedule/actual timing, terminal deploy states, missing identities, bridge rows, source snapshots, destination receipt evidence, and failure details. Private signing keys and database credentials are excluded. A setup failure also produces a failed report once the runner starts; fixture startup failures point to private service logs.

`npm test` exercises the harness's failure detection with missing/corrupted votes, dropped/duplicated/miscorrelated bridge rows, block-finality false positives, overloaded submission, and identity validation. These are harness tests, not a substitute for `test:local` or `test:live`.

## Recorded local validation — 2026-11-12

With node image `f1r3fly-rust:dev-b465313a2` (0.4.46) and bridge checkout `a89fb3bb8ba29d84dd07b29cc3b1e6b091491251`:

- All 11 harness checks passed.
- A reduced run with 2 voters and 10 bridge users × 5 locks passed: 52 finalized deploys, 50 verified destination deliveries, and stable source state across finalized heights 22–24. Convergence took 227.55 seconds after the submission window.
- The full run accepted all 1,100 deploys in 24.99 seconds but **failed the 900-second convergence deadline**: 419 finalized, 681 pending, and 6 archived bridge deliveries. No deploy was observed in `Failed` or `Expired` state.

The reduced run used a separate fixture while the full run was draining. These are integration results on this workstation, not an isolated throughput benchmark. Local evidence is in `artifacts/2026-11-12T12-48-05.860Z-b7eb386a/report.json` (full) and `artifacts/2026-11-12T12-53-50.721Z-4831e897/report.json` (reduced); artifacts are excluded from Git. The full run therefore establishes successful burst submission, but has not established the requested eventual completion at that load.

A rerun against the existing validator network at chain revision `7f477f93c871b19989a787d9cab456b5ee8e2879`, with the same bridge revision, accepted all 1,100 deploys by 25.62 seconds; the last request started at 24.98 seconds. It failed the 900-second convergence deadline with 950 votes finalized, 50 votes pending, all 100 bridge deploys pending, and zero bridge deliveries. A sampled pending bridge deploy had an errored inclusion. A read-only reproduction identified the bridge's `bal < amount` comparison as incompatible with the chain's new BigInt vault balances and the Int lock amount (`Unexpected compare: GBigInt ... vs GInt ...`). This does not establish permanent message loss. Evidence is in `artifacts/2026-11-12T13-57-22.857Z-fe1f1965/report.json` and `bridge-diagnostics.json` in that directory. All 14 harness checks passed after adding current protocol and existing-network support.

## Current validator network / ACMP validation — 2026-11-16

The network used chain revision `e0510c887862b601d6a8426c9755bbb4891f9646` and bridge revision `d29a723` (`fix/rust-client-dev-node-api`), with the supplied oracle image pinned to `sha256:c8c07c2d8acc6cf8ef3d168251dd5166a9cc4a5c75a53588c1fba63631250638`. ASI submissions use the existing validator network; the EVM chain and oracle database are dedicated local fixtures.

The first ACMP attempt accepted all 1,100 deploys in 24.98 seconds, finalized all of them in 312.06 seconds after submission, and delivered all 100 packets. Its parallel verification reads hit the current node's observer admission limit, so it was stopped without a consistency pass. Independent diagnostics verified all 100 EVM payloads and 200 receive/process events, then the corrected sequential source reader verified all 1,000 votes and 100 packet records. Evidence: `artifacts/2026-11-16T13-24-22.130Z-dcd4017c/`. The original report remains failed; these diagnostic checks do not replace the stability requirement.

All 20 harness checks pass, including observer backoff/deadline handling and draining in-flight read operations after an error.

The clean rerun **passed** against the same existing network:

- **1,100/1,100 deploys accepted in 24.98 seconds**: 1,000 distinct voters and 10 bridge users sending 10 messages each.
- **1,100/1,100 deploys finalized**, with no execution failures or unresolved deploys.
- Every configured node's finalized snapshot contained exactly **1,000 votes (500 yes / 500 no)** and **100 matching packet records**. State queries used the read-only node at each node's explicit finalized block hash; deploy receipts were checked on each node.
- **100/100 messages archived and independently verified on EVM**, with exact receiver payloads, 100 receive events, 100 process events, and canonical receipts with two confirmations. The active queue was empty.
- Complete reconciliation and stability verification finished **809.86 seconds after submission** (13 minutes 30 seconds), inside the 900-second limit. State remained correct across later finalized blocks on all five nodes over **79.92 seconds**.

Passing report: `artifacts/2026-11-16T13-46-47.915Z-0a579339/report.json`. The fixture cleaned up its EVM/oracle/PostgreSQL services; the existing ASI validator network remained running and healthy.
