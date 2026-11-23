#!/bin/sh
# Builds the `dray` CLI for Tauri's `externalBin` (tauri.cli.conf.json), which
# ships it in the bundle as `dray-cli` beside the app's binary: Contents/MacOS
# on a Mac, usr/bin in the AppImage, the install folder on Windows. The app
# copies it to ~/.local/bin/dray on launch (cli.rs).
#
#   cli-sidecar.sh <out-dir>
#
# On a Mac, three files: one per arch and the `-universal-apple-darwin` one the
# bundler ships. tauri-build copies the file named for the triple it compiles
# beside the binary and fails without one, but never ships it — so release.yml,
# compiling each arch on its own runner while this runs on another, hands those
# a stand-in, and only the universal file has to be real.
# On Linux and Windows, one, for the host's triple, since both build natively;
# Windows's carries `.exe`, which the bundler looks for there. Run it under Git
# Bash.
# Named dray-cli, not dray: the app's own executable holds that name. Signed on
# a Mac by the bundler, which signs what it copies itself.
set -e
[ -n "$1" ] || { echo "usage: $0 <out-dir>" >&2; exit 1; }
mkdir -p "$1"
OUT=$(cd "$1" && pwd)
cd "$(dirname "$0")/../../cli"

if [ "$(uname -s)" != Darwin ]; then
  t=$(rustc -vV | sed -n 's/^host: //p' | tr -d '\r')
  x=
  case "$t" in *-windows-*) x=.exe ;; esac
  cargo build --release --locked --target "$t"
  cp "target/$t/release/dray$x" "$OUT/dray-cli-$t$x"
  exit
fi

for t in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo build --release --locked --target "$t"
  cp "target/$t/release/dray" "$OUT/dray-cli-$t"
done
lipo -create -output "$OUT/dray-cli-universal-apple-darwin" \
  "$OUT/dray-cli-aarch64-apple-darwin" "$OUT/dray-cli-x86_64-apple-darwin"
