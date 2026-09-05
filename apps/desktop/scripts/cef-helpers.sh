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
#
# As `beforeBundleCommand` (tauri.cef.conf.json) it builds nothing and reads
# all three off the CLI's own env. `tauri build` compiles every [[bin]] per
# target already, and it does so with `MACOSX_DEPLOYMENT_TARGET` set from
# `minimumSystemVersion` and `tauri/custom-protocol` on — a cargo build here
# with any other env or feature set is not a cache miss on a few crates but a
# rebuild of the tree: every crate `cc` compiles fingerprints that variable,
# so libgit2, ring, lmdb, the CEF wrapper and everything above them go dirty,
# and the CLI's build then flips them all back. Measured on v0.14.0-beta.4:
# 65 crates here, 63 of the same again in the CLI, 28 of 31 minutes.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -n "$1" ] || { echo "usage: $0 <out-dir>" >&2; exit 1; }
# Absolute before the cd below, or a relative out-dir lands under src-tauri.
mkdir -p "$1"
OUT=$(cd "$1" && pwd)
PROFILE=${PROFILE:-debug}
if [ -n "$TAURI_ENV_TARGET_TRIPLE" ]; then
  PROFILE=release
  [ "$TAURI_ENV_DEBUG" = true ] && PROFILE=debug
  case "$TAURI_ENV_TARGET_TRIPLE" in
    universal-apple-darwin) TARGETS="aarch64-apple-darwin x86_64-apple-darwin" ;;
    # No `--target` reports the host triple, whose binary sits in the plain
    # profile dir; an explicit one puts it under the triple. Tried in that order.
    *) TARGETS="" ; TRIPLE=$TAURI_ENV_TARGET_TRIPLE ;;
  esac
  # The bundler's identity. Only a debug build may fall back to ad-hoc: an
  # ad-hoc helper passes `codesign --verify` and the entitlements grep, so a
  # release missing the secret would go green here and fail on a user's Mac.
  SIGN_IDENTITY=${SIGN_IDENTITY:-$APPLE_SIGNING_IDENTITY}
  if [ -z "$SIGN_IDENTITY" ]; then
    [ "$PROFILE" = debug ] || { echo "$0: release build with no APPLE_SIGNING_IDENTITY" >&2; exit 1; }
    SIGN_IDENTITY=-
  fi
fi
FLAG=""
[ "$PROFILE" = release ] && FLAG=--release

build() {
  [ -n "$TAURI_ENV_TARGET_TRIPLE" ] || cargo build $FLAG --bin dray-helper --features cef "$@"
}

# Hardened-runtime codesign, or nothing without SIGN_IDENTITY. An ad-hoc
# signature cannot carry a timestamp.
sign() {
  [ -n "$SIGN_IDENTITY" ] || return 0
  T=--timestamp
  [ "$SIGN_IDENTITY" = "-" ] && T=""
  codesign --force --options runtime $T -s "$SIGN_IDENTITY" "$@"
}

cd "$ROOT/src-tauri"
mkdir -p "$OUT"
if [ -n "$TARGETS" ]; then
  BINS=""
  for t in $TARGETS; do
    build --target "$t"
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
  sign "$UNI/dray-helper"
else
  build
  BIN="target/$PROFILE/dray-helper"
  [ -n "$TRIPLE" ] && [ -e "target/$TRIPLE/$PROFILE/dray-helper" ] && BIN="target/$TRIPLE/$PROFILE/dray-helper"
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
  sign --entitlements "$ROOT/src-tauri/HelperEntitlements.plist" "$app"
done

echo "cef helpers at $OUT"
