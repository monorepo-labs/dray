#!/bin/sh
# Assembles the macOS layout CEF needs beside the *debug* binary, so
# `pnpm tauri dev` can host Chromium without a real .app: a fake bundle at
# target/debug/cef/Dray.app whose Contents/Frameworks holds the framework
# (symlinked from CEF_PATH) and the five helper apps CEF resolves by name.
# Release bundles get the helpers from the same script and the framework
# from the download in chromium.rs; to try that route under dev, remove the
# framework symlink this leaves.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CEF=${CEF_PATH:-$HOME/.local/share/cef}
FRAMEWORK="$CEF/Chromium Embedded Framework.framework"
OUT="$ROOT/src-tauri/target/debug/cef/Dray.app"
FW="$OUT/Contents/Frameworks"

[ -d "$FRAMEWORK" ] || { echo "no CEF at $CEF — run: cargo run -p export-cef-dir -- --force $CEF (from a cef-rs checkout)"; exit 1; }

mkdir -p "$OUT/Contents/MacOS"
CEF_PATH="$CEF" "$ROOT/scripts/cef-helpers.sh" "$FW"
ln -sfn "$FRAMEWORK" "$FW/Chromium Embedded Framework.framework"

echo "cef dev bundle at $OUT"
