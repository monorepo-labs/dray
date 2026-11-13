#!/bin/sh
# Builds Dray Island for Linux (apps/island-linux) for Tauri's `externalBin`
# (tauri.island-linux.conf.json), which ships it in the AppImage as usr/bin/dray-island,
# beside the app's binary, where island.rs looks for it.
#
#   island-sidecar.sh <out-dir>
#
# Linux only, for the host's triple, as the AppImage is built natively. The
# Mac's island is a SwiftUI app of its own (apps/island) and never comes here.
set -e
[ -n "$1" ] || { echo "usage: $0 <out-dir>" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo "$0: Linux only" >&2; exit 1; }
mkdir -p "$1"
OUT=$(cd "$1" && pwd)
cd "$(dirname "$0")/../../island-linux"
t=$(rustc -vV | sed -n 's/^host: //p')
cargo build --release --locked --target "$t"
cp "target/$t/release/dray-island" "$OUT/dray-island-$t"
