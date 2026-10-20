#!/bin/sh
# Builds Dray Notch.app, universal, and signs it into <out-dir> for the
# release bundle (tauri.notch.conf.json copies it into Contents/Helpers).
#
#   build.sh <out-dir>
#     SIGN_IDENTITY=...   codesign identity, hardened runtime (default ad-hoc)
#
# Signed here rather than by Xcode for cef-helpers.sh's reason: Tauri's bundler
# signs nothing `bundle.macOS.files` copied, and codesign refuses an app whose
# nested bundles carry no signature.
set -e
[ -n "$1" ] || { echo "usage: $0 <out-dir>" >&2; exit 1; }
mkdir -p "$1"
OUT=$(cd "$1" && pwd)
cd "$(dirname "$0")"

xcodegen generate --quiet
xcodebuild -quiet -project DrayNotch.xcodeproj -scheme DrayNotch -configuration Release \
  -derivedDataPath build ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO build

APP="$OUT/Dray Notch.app"
rm -rf "$APP"
cp -R "build/Build/Products/Release/Dray Notch.app" "$APP"
ID=${SIGN_IDENTITY:--}
# An ad-hoc signature cannot carry a timestamp.
T=--timestamp
[ "$ID" = "-" ] && T=""
codesign --force --options runtime $T -s "$ID" "$APP"
echo "notch at $APP"
