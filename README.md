# Real ASI:chain usage integration test

A Rholang ballot receives one vote from each of **1,000 distinct users** while **10 other users each submit 10 ASI bridge locks**, all paced across **25 seconds**. The default destination is a local EVM chain running the real Solidity bridge. The real Rust watcher, finalizer, three verifiers, and relayer process the messages through PostgreSQL.

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

`COMPLETION_TIMEOUT_MS` overrides the 15-minute drain deadline. The exit status is 0 only on a complete pass.

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
