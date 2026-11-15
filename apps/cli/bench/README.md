# dray / dray-serve benchmarks (#1130)

Linux only. Needs python3, `unshare`, `ip`, GNU `time`, `readelf`, `nm`, `strip`.

```bash
cd apps/cli/bench
./bench.py run baseline                    # clean release build of both, then measure everything
./bench.py run after                       # the same on your branch
./bench.py compare baseline after          # one markdown table: metric | before | after | change %

./bench.py run x --reuse-build             # measure again what `build x` / `run x` built
./bench.py run x --reuse-build --only hot  # one group of: size, cli, startup, memory, hot
./bench.py run x --serve-env CARGO_PROFILE_SERVE_OPT_LEVEL=3 --cli-bin ~/dray-bench-results/baseline/dray
./bench.py run x --reuse-build --server-env LD_PRELOAD=/path/libjemalloc.so.2   # env for the server itself
./bench.py bloat baseline                  # dray-serve size by crate and biggest functions
./matrix.sh                                # dray-serve's `serve` profile at opt 3 / s / z
```

- Builds match `.github/workflows/release-cli.yml` for the host target, in a private target dir, so each build time is a clean one: `dray` at its `release` profile, `dray-serve` at the `serve` profile in `apps/desktop/src-tauri/Cargo.toml`. `DRAY_BENCH_SERVE_PROFILE=release` builds a tree from before that profile existed. `--env`, `--serve-env` and `--cli-env` pass build settings; `--serve-bin`/`--cli-bin` skip a build and measure a given binary. `DRAY_BENCH_REPO` builds another source tree (a `git archive` of a tag).
- Results go to `~/dray-bench-results/<label>.json`, with binaries (stripped and unstripped), build logs and server logs in `~/dray-bench-results/<label>/`. Never commit them.
- The populated home (500 sessions, 40+10+10 MB logs) is built once, by the first run, into `~/dray-bench-results/data/`, and every later label reads the same bytes. Delete that folder to rebuild it.
- Each bench server gets its own `DRAY_HOME` under a fresh `/tmp` dir, a scrubbed environment and a network namespace with only loopback, so it cannot reach the real server's home or the network. A fake `claude` ([fake_claude.sh](fake_claude.sh)) replays `complex.jsonl`, so turns run with no agent.
- Before each timed group the script waits until no `cargo`/`rustc` runs and the 1-minute load is at or under 35% of the cores (`DRAY_BENCH_LOAD_LIMIT` overrides). `DRAY_BENCH_QUICK=1` skips that and cuts runs to 3: for working on the harness only.
- Short operations run 20 times (200 for the wire round trip) after a warmup; JSON keeps median, min, p95 and n. Wall times include the Python client's own cost, the same on both sides of a compare.
