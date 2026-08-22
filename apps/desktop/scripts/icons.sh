#!/usr/bin/env bash
# Regenerate the bundled icons from the 1024px masters in src-tauri/icons/src.
# Run after replacing a master; the outputs are committed, so this is not part
# of any build.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="src-tauri/icons/src"
OUT="src-tauri/icons"

# The masters are Icon Composer's iOS export: full-bleed to the canvas edge.
# macOS sizes dock icons off a 824/1024 grid, so an icns built from full-bleed
# art draws visibly larger than every neighbour. Inset for the icns only — the
# flat PNGs are the window/Linux/tray icon, where full-bleed is right.
INSET=824

# `tauri::generate_context!` rejects a window icon that isn't RGBA, and magick
# happily writes a palette PNG when the resized art has few enough colours — so
# every PNG is forced to 32-bit rather than left to that heuristic.
PNG32=PNG32:

make_icns() {
  local src="$1" dest="$2" tmp iconset
  tmp="$(mktemp -d)"
  iconset="$tmp/icon.iconset"
  mkdir -p "$iconset"
  magick "$src" -resize "${INSET}x${INSET}" -background none -gravity center \
    -extent 1024x1024 "$tmp/master.png"
  for pair in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" \
              "128 128x128" "256 128x128@2x" "256 256x256" "512 256x256@2x" \
              "512 512x512" "1024 512x512@2x"; do
    local px="${pair% *}" name="${pair#* }"
    magick "$tmp/master.png" -resize "${px}x${px}" "$PNG32$iconset/icon_$name.png"
  done
  iconutil -c icns "$iconset" -o "$dest"
  rm -rf "$tmp"
}

make_flat() {
  local src="$1" dir="$2"
  magick "$src" -resize 32x32 "$PNG32$dir/32x32.png"
  magick "$src" -resize 128x128 "$PNG32$dir/128x128.png"
  magick "$src" -resize 256x256 "$PNG32$dir/128x128@2x.png"
  magick "$src" -resize 1024x1024 "$PNG32$dir/icon.png"
}

make_flat "$SRC/icon-1024.png" "$OUT"
make_icns "$SRC/icon-1024.png" "$OUT/icon.icns"
magick "$SRC/icon-1024.png" -define icon:auto-resize=256,128,64,48,32,16 "$OUT/icon.ico"

mkdir -p "$OUT/dev"
make_flat "$SRC/icon-dev-1024.png" "$OUT/dev"
make_icns "$SRC/icon-dev-1024.png" "$OUT/dev/icon.icns"

echo "icons regenerated"
