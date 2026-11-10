#!/usr/bin/env bash
# Build the app and install it over the copy in /Applications.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$ROOT/src-tauri/tauri.conf.json"
DEST_DIR="${DEST_DIR:-/Applications}"

NAME="$(/usr/bin/jq -r .productName "$CONF")"
BUNDLE_ID="$(/usr/bin/jq -r .identifier "$CONF")"
DEST="$DEST_DIR/$NAME.app"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# `createUpdaterArtifacts` makes the bundler sign the update package, and it
# refuses to build at all when the config carries a public key with no private
# one to match. CI passes the key as a secret; locally it is the file the
# keypair was generated into.
UPDATER_KEY="${TAURI_SIGNING_PRIVATE_KEY:-$HOME/.tauri/dray_updater.key}"
[ -f "$UPDATER_KEY" ] || die "no updater signing key at $UPDATER_KEY — generate one with \`pnpm tauri signer generate\` or set TAURI_SIGNING_PRIVATE_KEY"
export TAURI_SIGNING_PRIVATE_KEY="$UPDATER_KEY"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

say "Building $NAME"
cd "$ROOT"
pnpm tauri build "$@"

# `--target` moves the bundle under target/<triple>/, so find it rather than
# hardcoding target/release.
SRC="$(find "$ROOT/src-tauri/target" -maxdepth 4 -name "$NAME.app" -type d \
  -path '*/bundle/macos/*' -print0 2>/dev/null \
  | xargs -0 ls -dt 2>/dev/null | head -1)"
[ -n "$SRC" ] && [ -d "$SRC" ] || die "no $NAME.app under src-tauri/target after build"
say "Built $SRC"

# The app's own processes, without its background server. `dray --serve`
# runs from this same bundle and is meant to outlive the app: it holds every
# session, keeps the inodes it started from when the bundle is moved aside, and
# restarts itself once idle on seeing the newer binary. Matched here, it read as
# the app still running and was killed with every turn it held.
app_pids() {
  pgrep -f "$DEST/Contents/MacOS/" 2>/dev/null | while read -r pid; do
    ps -o args= -p "$pid" 2>/dev/null | grep -q -- ' --serve' || echo "$pid"
  done
}

# Replacing the bundle under a running process leaves it half-swapped.
WAS_RUNNING=0
if [ -n "$(app_pids)" ]; then
  WAS_RUNNING=1
  say "Quitting running $NAME"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 20); do
    [ -n "$(app_pids)" ] || break
    sleep 0.25
  done
  app_pids | xargs kill 2>/dev/null || true
  sleep 0.5
fi

BACKUP=""
if [ -d "$DEST" ]; then
  BACKUP="$(mktemp -d)/$NAME.app"
  say "Backing up existing install"
  mv "$DEST" "$BACKUP"
fi

# ditto over cp -R: it preserves the bundle's metadata and code signature.
say "Installing to $DEST"
if ditto "$SRC" "$DEST"; then
  [ -n "$BACKUP" ] && rm -rf "$(dirname "$BACKUP")"
else
  if [ -n "$BACKUP" ]; then
    rm -rf "$DEST"
    mv "$BACKUP" "$DEST"
    die "install failed; restored the previous $NAME.app"
  fi
  die "install failed"
fi

# Gatekeeper keeps the pre-swap bundle cached otherwise, so the first launch fails.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

say "Installed $NAME $(/usr/bin/jq -r .version "$CONF") to $DEST"
if [ "$WAS_RUNNING" = 1 ] || [ "${OPEN_AFTER:-0}" = 1 ]; then
  say "Relaunching"
  open "$DEST"
fi
