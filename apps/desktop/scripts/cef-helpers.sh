#!/bin/sh
# Builds `dray-helper` and lays out the five helper apps CEF launches for its
# renderer, GPU, plugin and alert processes: one binary under five names,
# since only the bundle name tells them apart. The dev layout and the release
# bundle both take theirs from here; the framework is never part of it.
#
#   cef-helpers.sh <out-dir>
#     PROFILE=release        cargo profile (default debug)
#     TARGETS="t1 t2"        build each triple and lipo them (default: host)
#     SIGN_IDENTITY=...      codesign each app: hardened runtime, helper
#                            entitlements. Tauri's bundler signs nothing it
#                            did not copy itself, and codesign refuses an app
#                            whose nested bundles carry no signature.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -n "$1" ] || { echo "usage: $0 <out-dir>" >&2; exit 1; }
# Absolute before the cd below, or a relative out-dir lands under src-tauri.
mkdir -p "$1"
OUT=$(cd "$1" && pwd)
PROFILE=${PROFILE:-debug}
FLAG=""
[ "$PROFILE" = release ] && FLAG=--release

cd "$ROOT/src-tauri"
mkdir -p "$OUT"
if [ -n "$TARGETS" ]; then
  BINS=""
  for t in $TARGETS; do
    cargo build $FLAG --bin dray-helper --features cef --target "$t"
    BINS="$BINS target/$t/$PROFILE/dray-helper"
  done
  BIN="$OUT/dray-helper"
  lipo -create $BINS -output "$BIN"
  # Tauri's universal build lipos the app binary alone, then its bundler
  # demands every [[bin]] in the package at that same path — so a universal
  # release fails on a helper the host-arch build gets for free. Signed here
  # for the same reason the app bundles are: the bundler signs nothing it did
  # not build, and an unsigned Mach-O in Contents/MacOS fails notarization.
  UNI="target/universal-apple-darwin/$PROFILE"
  mkdir -p "$UNI"
  cp "$BIN" "$UNI/dray-helper"
  if [ -n "$SIGN_IDENTITY" ]; then
    T=--timestamp
    [ "$SIGN_IDENTITY" = "-" ] && T=""
    codesign --force --options runtime $T -s "$SIGN_IDENTITY" "$UNI/dray-helper"
  fi
else
  cargo build $FLAG --bin dray-helper --features cef
  BIN="target/$PROFILE/dray-helper"
fi

for suffix in "" " (GPU)" " (Renderer)" " (Plugin)" " (Alerts)"; do
  name="Dray Helper$suffix"
  app="$OUT/$name.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS"
  cp "$BIN" "$app/Contents/MacOS/$name"
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
  if [ -n "$SIGN_IDENTITY" ]; then
    # An ad-hoc signature cannot carry a timestamp.
    TS=--timestamp
    [ "$SIGN_IDENTITY" = "-" ] && TS=""
    codesign --force --options runtime $TS \
      --entitlements "$ROOT/src-tauri/HelperEntitlements.plist" \
      -s "$SIGN_IDENTITY" "$app"
  fi
done

echo "cef helpers at $OUT"
