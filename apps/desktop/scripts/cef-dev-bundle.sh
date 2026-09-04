#!/bin/sh
# Assembles the macOS layout CEF needs beside the *debug* binary, so
# `pnpm tauri dev` can host Chromium without a real .app: a fake bundle at
# target/debug/cef/Dray.app whose Contents/Frameworks holds the framework
# (symlinked from CEF_PATH) and the five helper apps CEF resolves by name.
# The helper binary is built here too. Release bundles get the same layout
# from the bundler step instead.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CEF=${CEF_PATH:-$HOME/.local/share/cef}
FRAMEWORK="$CEF/Chromium Embedded Framework.framework"
TARGET="$ROOT/src-tauri/target/debug"
OUT="$TARGET/cef/Dray.app"
FW="$OUT/Contents/Frameworks"

[ -d "$FRAMEWORK" ] || { echo "no CEF at $CEF — run: cargo run -p export-cef-dir -- --force $CEF (from a cef-rs checkout)"; exit 1; }

(cd "$ROOT/src-tauri" && CEF_PATH="$CEF" cargo build --bin dray-helper --features cef)

mkdir -p "$FW" "$OUT/Contents/MacOS"
ln -sfn "$FRAMEWORK" "$FW/Chromium Embedded Framework.framework"

for suffix in "" " (GPU)" " (Renderer)" " (Plugin)" " (Alerts)"; do
  name="Dray Helper$suffix"
  app="$FW/$name.app"
  mkdir -p "$app/Contents/MacOS"
  cp "$TARGET/dray-helper" "$app/Contents/MacOS/$name"
  id=$(printf '%s' "$suffix" | tr -cd 'A-Za-z' | tr 'A-Z' 'a-z')
  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>com.yogesh.dray.helper${id:+.$id}</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><string>1</string>
  <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
</dict></plist>
EOF
done

echo "cef dev bundle at $OUT"
