#!/bin/sh
# Rebuilds Island/botface.js from face.ts. Run after a blobatar bump or a
# change to the app's botAvatar.ts; needs `pnpm install` done at the root.
# The output is checked in so building the island needs no Node.
set -e
cd "$(dirname "$0")"
# JavaScriptCore has no TextEncoder, which blobatar's seed hash uses for UTF-8.
NODE_PATH=../../desktop/node_modules npx --yes esbuild@0.28 face.ts --bundle --format=iife --minify \
  --outfile=../Island/botface.js \
  '--banner:js=globalThis.TextEncoder??=class{encode(s){return Uint8Array.from(unescape(encodeURIComponent(s)),c=>c.charCodeAt(0))}};'
