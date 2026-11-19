#!/usr/bin/env bash
# Installs and opens the Linux app the way a reader would, on a clean distro:
# run in a fresh `ubuntu:22.04` container by release.yml's `linux` job.
#
#   linux-smoke.sh <bundle-dir> <out-dir>
#
# The .deb goes in through apt, which must find every library it needs from
# the package's own Depends; then the app opens on a virtual display and must
# draw its window. The AppImage then opens on the same system, with what the
# .deb pulled in standing in for a desktop's libraries — extracted, since a
# container has no FUSE. A screenshot of each lands in <out-dir>.
set -euo pipefail
bundle=$1 out=$2
export DEBIAN_FRONTEND=noninteractive
mkdir -p "$out"

apt-get update -qq
apt-get install -y -qq "$(ls "$bundle"/deb/*.deb)" >/dev/null
# Only what this test needs: a display, a window lister, a screenshot.
apt-get install -y -qq xvfb x11-utils imagemagick >/dev/null

Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
export DISPLAY=:99

# Waits for a top-level window titled "Dray", then screenshots it.
opens() {
  local name=$1
  shift
  "$@" >"$out/$name.log" 2>&1 &
  local pid=$!
  for _ in $(seq 60); do
    if xwininfo -root -tree | grep -q '"Dray"'; then
      sleep 5
      import -window root "$out/$name.png"
      kill "$pid" 2>/dev/null || true
      pkill -f 'dray-(app|island)' 2>/dev/null || true
      sleep 2
      echo "$name: window drawn"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  echo "$name: no window" >&2
  tail -40 "$out/$name.log" >&2
  return 1
}

opens deb dray-app

cd "$(mktemp -d)"
"$(ls "$bundle"/appimage/*.AppImage)" --appimage-extract >/dev/null
opens appimage ./squashfs-root/AppRun
