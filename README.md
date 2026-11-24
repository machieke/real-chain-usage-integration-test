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

When `/status` advertises `maxPhloLimit`, setup and workload deploy budgets are capped before signing. The report records the requested limit, advertised maximum, and actual workload limit. Funding preserves its original allowance of one million phlo per recipient by reducing the batch size: a 20-million cap uses batches of 20 accounts instead of 100. Funding and contract setup remain outside the timed workload. Older nodes without an advertised cap retain the previous budgets.

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

The defaults request a phlo price of 1 and a 100,000,000 phlo limit per workload deploy, bounded by the node's advertised cap when present. Each bridge lock transfers 100,000,000 raw ASI units (1 ASI). Fund each signer for deploy precharges and bridge amounts; provide enough destination liquidity. Source and shared decimals are 8. All configured observers must support exploratory reads at explicit finalized block hashes and the submit node must expose `/api/deploy-finalization-status`.

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


## Existing network at height 31,890 — 2026-11-20

A repeat of the same 1,000-voter / 100-message ACMP workload **failed the 900-second convergence deadline**. The source deployment height was **31,890**, compared with **592** in the passing November 16 run. The bridge revision and oracle image were unchanged; the chain was now running `0380cbbd4` with deploy-queue services.

| Measurement | Height 592 baseline | Height 31,890 run |
| --- | ---: | ---: |
| Accepted deploys | 1,100 / 1,100 | 1,100 / 1,100 |
| Burst acknowledgement duration | 24.978 s | 24.982 s |
| Request latency, p95 | 27.29 ms | 16.46 ms |
| All deploys finalized after burst | 523.13 s | Not complete at 900 s |
| Finalized deploys at completion/deadline | 1,100 | 723 |
| Archived bridge messages | 100 / 100 | 19 / 100 |
| Consistency result | PASS at 809.86 s | Deadline exceeded |

At the deadline, 704 votes and 19 bridge deploys were finalized; **296 votes and 81 bridge deploys remained Pending**. No deploy was observed in `Failed` or `Expired`, and no finalized execution reported an error. Full source/destination reconciliation was not reached, so the 19 archived bridge messages were not independently reverified by the final consistency check. Pending deploys are not evidence of permanent message loss.

The read-only replica lag grew from 22 to 35 blocks during the run; a post-deadline observation found it 61 blocks behind the leading validators. Oracle worker health was healthy with zero consecutive failures near the deadline. The host had 8 available CPUs and averaged **99.86% CPU busy** during the sampled workload, with load average reaching 46.34. Completion was slower under these conditions, but the changed chain build and CPU contention prevent attributing the difference to block height alone. Polling times are observations rather than exact consensus timestamps.

An initial setup attempt stopped before workload submission because an oracle migration deadlocked against another worker. The fixture now passes `DB_SCHEMA_MODE=bootstrap` after creating the complete schema itself, avoiding repeated worker migrations. This only changes setup; the timed workload, observer targets, verification rules, and deadline remain the same. The resumed setup succeeded, and only one timed burst was submitted for this comparison.

Evidence: `artifacts/2026-11-20T13-54-33.512Z-0f21e473/report.json`, `performance-comparison.json`, `performance-comparison.png`, `network-before.json`, `network-after.json`, and the saved host/oracle diagnostics in the same directory. The existing validator network remained running; the fixture cleaned up its own services.

## Existing network after stopping Chrome, height 32,505 — 2026-11-20

The same workload **passed** after Chrome was stopped, without restarting or resetting the existing ASI network. This run used fresh accounts and contracts, the same chain revision `0380cbbd4` and immutable oracle image as the earlier high-height run, and unchanged submission and verification rules. Before setup, all five nodes agreed on finalized height 32,380; the timed workload started at height **32,505**. No Chrome processes were found before or after the run.

| Measurement | Height 592 baseline | Height 31,890, CPU saturated | Height 32,505, Chrome stopped |
| --- | ---: | ---: | ---: |
| Accepted deploys | 1,100 / 1,100 | 1,100 / 1,100 | 1,100 / 1,100 |
| Burst acknowledgement duration | 24.978 s | 24.982 s | 24.982 s |
| Request latency, p95 | 27.29 ms | 16.46 ms | 6.81 ms |
| All deploys finalized after burst | 523.13 s | Not complete at 900 s | 303.13 s |
| All bridge messages archived after burst | 653.29 s | Not complete at 900 s | 323.16 s |
| Finalized deploys at completion/deadline | 1,100 | 723 | 1,100 |
| Archived bridge messages | 100 / 100 | 19 / 100 | 100 / 100 |
| Full reconciliation and stability after archival | 156.57 s | Not reached | 271.97 s |
| Consistency result, time after burst | PASS at 809.86 s | Deadline exceeded | PASS at 595.13 s |
| Mean sampled host CPU busy | Not recorded | 99.86% | 65.01% |

All **1,000 votes and 100 bridge deploys finalized**, with zero failed or unresolved deploys and no execution errors. Every configured node's finalized snapshot contained the exact 1,000-voter map (500 yes / 500 no) and 100 matching source packets. All **100 destination messages** passed independent verification, including exact payloads, 100 receive events, 100 process events, canonical receipts, and two confirmations. No missing or duplicate effects were observed. The active oracle queue was empty. Correct state persisted across later finalized blocks on all five nodes over **137.96 seconds**; final snapshot heights ranged from 32,657 to 32,690.

Overall completion was **26.5% faster** than the low-height baseline; finalization was 42.1% faster and archival was 50.5% faster. However, the full reconciliation and stability phase was **73.7% slower** (271.97 versus 156.57 seconds). This run therefore shows no overall completion slowdown at 32k height, but it does show slower verification. These phase timings do not isolate which reads slowed down or establish a block-height cause: the low-height run used a different chain build, and its CPU utilization was not recorded. The two high-height runs used the same builds but different host load and starting chain state. CPU samples were collected every 15 seconds; the current workload averaged 65.01% busy and peaked at 93.42%, compared with 99.86% average in the saturated run. Finality and archival times are polling observations.

A separate read-only follow-up at 14:32 UTC checked the previous saturated run's 377 unresolved deploys: **238 had finalized later** (168 votes, 70 bridge deploys), while **139 were marked Expired** (128 votes, 11 bridge deploys). This does not change that run's original failed report or establish destination delivery for its later-finalized bridge deploys. The successful new run used separate identities and did not resubmit the previous workload.

Evidence: `artifacts/2026-11-20T14-39-46.966Z-9f059ce6/report.json`, `performance-comparison.json`, `performance-comparison.png`, `performance-comparison.svg`, `network-before.json`, `network-after.json`, `network-samples.jsonl`, `host-samples.jsonl`, `host-utilization-summary.json`, and `previous-run-followup.json`. These local artifacts remain excluded from Git. The harness implementation was unchanged during this rerun. The fixture cleaned up all its own services; all eight existing ASI node/deploy-queue containers stayed running and healthy, and all five read endpoints agreed on finalized height 32,710 after cleanup.

## Existing network on build 2aa0e81db, height 801 — 2026-11-23

The repeat **passed** with the same 1,000-voter / 100-message ACMP workload and 900-second convergence deadline. Before this invocation, the existing network was already running chain revision `2aa0e81db85f903638336c2ea19b51385752ea35` at finalized height 453. The harness did not restart or reset it. The timed workload began at height **801**, so this is a repeat on the current network, not another 32k-height measurement. The bridge revision `d29a723` and immutable oracle image were unchanged.

The node now advertises a **20,000,000 phlo maximum**. An initial funding request was rejected because the harness requested 100,000,000; after capping budgets, a 100-account funding transaction exhausted its 20,000,000 budget and setup timed out while its deploy state remained Pending. Node execution logs confirmed the out-of-phlo error. Both attempts stopped before the timed workload. The harness now applies the advertised cap before signing and scales funding batches with the available budget. Resumed setup checked finalized balances and funded 1,011 accounts in 51 batches of at most 20 accounts; the largest batch consumed 4,896,533 phlo. Exactly one timed workload was submitted, without resubmissions.

| Measurement | November 20 pass, height 32,505 | November 23 pass, height 801 |
| --- | ---: | ---: |
| Workload phlo limit per deploy | 100,000,000 | 20,000,000 |
| Accepted deploys | 1,100 / 1,100 | 1,100 / 1,100 |
| Burst acknowledgement duration | 24.982 s | 24.978 s |
| Request latency, p95 | 6.81 ms | 7.13 ms |
| All deploys finalized after burst | 303.13 s | 232.91 s |
| All bridge messages archived after burst | 323.16 s | 272.95 s |
| Full reconciliation and stability after archival | 271.97 s | 365.43 s |
| Full consistency pass after burst | 595.13 s | 638.37 s |
| Mean sampled host CPU busy | 65.01% | 55.72% |

All **1,100 deploys finalized**, with zero failed or unresolved workload deploys and no execution errors. Each of the five finalized source snapshots contained exactly 1,000 votes (500 yes / 500 no) and 100 matching packets. All **100 EVM deliveries** passed independent payload, receipt, confirmation, and event checks: exactly 100 receive events and 100 process events, with no missing or duplicate effects and no active oracle queue rows. Complete state remained correct across later finalized blocks on every node over **185.89 seconds**; final snapshot heights ranged from 949 to 989.

Finalization was 23.2% faster and archival 15.5% faster than the previous pass, but reconciliation and stability verification took 34.4% longer. Overall completion was **7.3% slower**, at **10 minutes 38 seconds** after the burst, still within the 15-minute deadline. The changed chain build, starting height/state, phlo budget, and host utilization prevent isolating a block-height effect or attributing the slower verification to a particular cause. Setup time is excluded from these phase timings; finality and archival completion are polling observations.

All **23 harness checks passed**, including the new coverage for capped signatures, older nodes without a cap, and funding batches with a partial final batch. The final report, signed workload, source/destination evidence, and cleanup were also checked. All eight original ASI containers retained their identities and start times and remained healthy; the five read endpoints agreed on finalized height 1,026 after cleanup. Only the fixture's own services were stopped.

Evidence: `artifacts/2026-11-23T12-40-12.551Z-1c60dd6a/report.json`, `performance-comparison.json`, `performance-comparison.png`, `performance-comparison.svg`, `network-before.json`, `network-after.json`, host/network samples, `funding-summary.json`, `harness-tests.log`, `run.log`, and the separate setup diagnostics in that directory. Artifacts remain local and excluded from Git.

## Existing network on build f7ef1bca1, height 971 — 2026-11-24

The same workload **passed** on the existing network running chain revision `f7ef1bca13713800ae7e04bef33387012bd36965`. The network was already running this build at approximately finalized height 730 before invocation; the harness did not restart or reset it. Fresh accounts were funded in 51 batches, and exactly one timed workload was submitted, starting at height **971**. Setup completed on the first attempt, with no workload resubmissions or harness changes. The harness implementation at `941441d`, bridge revision `d29a723`, immutable oracle image, full scenario configuration, observer endpoints, and verification rules were unchanged from the November 23 pass; both workloads used the node-advertised 20-million-phlo limit.

| Measurement | November 23 pass, height 801 | November 24 pass, height 971 |
| --- | ---: | ---: |
| Accepted deploys | 1,100 / 1,100 | 1,100 / 1,100 |
| Burst acknowledgement duration | 24.978 s | 24.979 s |
| Request latency, p95 | 7.13 ms | 7.30 ms |
| All deploys finalized after burst | 232.91 s | 242.29 s |
| All bridge messages archived after burst | 272.95 s | 292.35 s |
| Full reconciliation and stability after archival | 365.43 s | 396.22 s |
| Full consistency pass after burst | 638.37 s | 688.56 s |
| Mean sampled host CPU busy | 55.72% | 56.74% |

All **1,000 votes and 100 bridge deploys finalized**, with zero failed or unresolved workload deploys and no execution errors. Every configured node's finalized snapshot contained the exact 1,000-voter map (500 yes / 500 no) and 100 matching packets. All **100 EVM deliveries** passed independent verification, including exact payloads, canonical receipts with two confirmations, 100 receive events, and 100 process events. No missing or duplicate effects were observed, and the active oracle queue was empty. Correct state persisted across later finalized blocks on every node over **203.11 seconds**; final snapshot heights ranged from 1,132 to 1,173.

Full completion took **11 minutes 28.56 seconds** after the burst, inside the 900-second limit and **7.9% slower** than the previous pass. Finalization took 4.0% longer, archival 7.1% longer, and reconciliation plus stability 8.4% longer. Host utilization was similar, averaging 56.74% busy and peaking at 94.47%. This is one observation on each build with different starting chain state; it does not isolate a build or block-height effect. Setup remains excluded from these timings, and finality/archival completion are polling observations.

The report, signed workload, complete source/destination evidence, matching scenario and bridge configuration, and cleanup were checked. All eight original ASI containers retained their identities and start times and remained healthy. After cleanup, the five read endpoints were ready at finalized heights 1,210–1,211; no containers belonging to this fixture remained running.

Evidence: `artifacts/2026-11-24T12-44-11.862Z-bcf2b39e/report.json`, `performance-comparison.json`, `performance-comparison.png`, `performance-comparison.svg`, `network-before.json`, `network-after.json`, host/network samples, `funding-summary.json`, `evidence-checks.json`, and `run.log`. Artifacts remain local and excluded from Git.
