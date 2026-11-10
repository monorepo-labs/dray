#!/bin/sh
# Builds the `dray` CLI for Tauri's `externalBin` (tauri.cli.conf.json), which
# ships it in the bundle as Contents/MacOS/dray-cli. The app copies it to
# ~/.local/bin/dray on launch (cli.rs).
#
#   cli-sidecar.sh <out-dir>
#
# Three files, because `tauri build --target universal-apple-darwin` compiles
# the app once per arch, and tauri-build copies the sidecar named for each
# arch's triple before the bundler takes the `-universal-apple-darwin` one.
# Named dray-cli, not dray: the app's own executable holds that name in
# Contents/MacOS. Signed by the bundler, which signs what it copies itself.
set -e
[ -n "$1" ] || { echo "usage: $0 <out-dir>" >&2; exit 1; }
mkdir -p "$1"
OUT=$(cd "$1" && pwd)
cd "$(dirname "$0")/../../cli"

for t in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo build --release --locked --target "$t"
  cp "target/$t/release/dray" "$OUT/dray-cli-$t"
done
lipo -create -output "$OUT/dray-cli-universal-apple-darwin" \
  "$OUT/dray-cli-aarch64-apple-darwin" "$OUT/dray-cli-x86_64-apple-darwin"
