#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_REPO="${BRIDGE_REPO:-$HOME/work/takopi/asi-bridge}"
export CARGO_TARGET_DIR="$ROOT/.local/build"
export RUSTFLAGS="${RUSTFLAGS:--C target-feature=+aes,+sse2}"
cargo +nightly-2026-02-09 build --locked \
  --manifest-path "$BRIDGE_REPO/asi-oracle-rs/Cargo.toml" \
  --package oracle --package asi-bridge-helper-rs \
  --bin oracle --bin deploy_signed_bridge -j "${BUILD_JOBS:-6}"
