#!/usr/bin/env bash
# Renders the launcher icon's bitmaps from the vector mark in res/drawable/ic_launcher_monochrome.xml:
# the foreground's soft shadow per density, and the legacy ic_launcher.png fallbacks.
# Needs rsvg-convert. Run after moving or resizing the mark:
#
#     apps/android/scripts/launcher_icon.sh
set -euo pipefail

res="$(cd "$(dirname "$0")/.." && pwd)/app/src/main/res"
path=$(grep -o 'android:pathData="[^"]*"' "$res/drawable/ic_launcher_monochrome.xml" | cut -d'"' -f2)
# The mark's place on the 108dp canvas, as ic_launcher_mark and ic_launcher_monochrome set it.
mark='translate(37.305 33) scale(0.21)'
# Measured against the iOS icon's shadow: a slightly smaller mark, 3dp down, blurred 1.4dp, 10% black.
shadow='translate(54 57) scale(0.205) translate(-79.5 -100)'
defs="<filter id=\"blur\" x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\"><feGaussianBlur stdDeviation=\"1.4\"/></filter>"
shadow_layer="<g filter=\"url(#blur)\" opacity=\"0.10\"><path transform=\"$shadow\" d=\"$path\"/></g>"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/shadow.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><defs>$defs</defs>$shadow_layer</svg>
EOF

# Legacy icons: the adaptive icon's visible 72dp as a rounded tile, 44dp on a 48dp canvas.
cat > "$tmp/legacy.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" viewBox="14.727 14.727 78.545 78.545"><defs>$defs
<linearGradient id="bg" x1="0" y1="18" x2="0" y2="90" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#F2F2F2"/></linearGradient>
<linearGradient id="mk" x1="0" y1="0" x2="0" y2="200" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0A0A0A"/><stop offset="1" stop-color="#303030"/></linearGradient>
<clipPath id="tile"><rect x="18" y="18" width="72" height="72" rx="16"/></clipPath></defs>
<g clip-path="url(#tile)"><rect width="108" height="108" fill="url(#bg)"/>$shadow_layer
<path transform="$mark" d="$path" fill="url(#mk)"/></g></svg>
EOF

for density in mdpi:1 hdpi:1.5 xhdpi:2 xxhdpi:3 xxxhdpi:4; do
  name=${density%%:*}
  scale=${density##*:}
  mkdir -p "$res/drawable-$name"
  rsvg-convert -w "$(echo "108 * $scale / 1" | bc)" "$tmp/shadow.svg" -o "$res/drawable-$name/ic_launcher_shadow.png"
  rsvg-convert -w "$(echo "48 * $scale / 1" | bc)" "$tmp/legacy.svg" -o "$res/mipmap-$name/ic_launcher.png"
done
