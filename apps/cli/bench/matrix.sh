#!/bin/sh
# dray-serve's opt-level matrix (#1130): the `serve` profile (fat LTO, one
# codegen unit) at opt levels 3, s and z, each a clean build measured whole.
# dray is the baseline one throughout, so its rows in `compare` show run-to-run
# noise. Needs `bench.py run baseline` first. Settings ride as env vars; no
# Cargo.toml moves.
set -eu
cd "$(dirname "$0")"
cli="${DRAY_BENCH_RESULTS:-$HOME/dray-bench-results}/baseline/dray"
for opt in 3 s z; do
  ./bench.py run "serve-fat-o$opt" --cli-bin "$cli" --serve-env CARGO_PROFILE_SERVE_OPT_LEVEL=$opt
done
