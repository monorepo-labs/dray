#!/usr/bin/env bash
# Grabs a still from every mp4 in public/ into public/posters/.
#
# The posters are what let the videos load lazily without leaving black
# tiles, so run this after dropping a new capture in and before adding its
# entry to src/lib/features.ts.
#
#   ./scripts/posters.sh          # only what is missing
#   ./scripts/posters.sh --force  # redo everything
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p public/posters

for video in public/*.mp4; do
  poster="public/posters/$(basename "${video%.mp4}").jpg"
  if [[ -f $poster && ${1:-} != --force ]]; then
    echo "skip $poster"
    continue
  fi
  # A second in, not frame zero: these captures open on a still window and an
  # opening frame is often the least representative one in the clip.
  ffmpeg -y -loglevel error -ss 1 -i "$video" -frames:v 1 -q:v 4 "$poster"
  echo "wrote $poster"
done
