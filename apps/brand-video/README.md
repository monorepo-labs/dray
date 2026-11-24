# Brand video: switch agents mid-task

A 15s, 1920×1080, 60fps announcement for X, in the brand look: the site and the
app's sign-in and What's New pages (black, the blue pixel field, 2px-gap cards,
Inter light headlines, mono labels). Not the app's task UI.

Every frame is a pure function of time (`src/scene.js`), so the render is
frame-perfect and any frame can be drawn on its own.

```bash
pnpm dev            # preview at http://127.0.0.1:5199/?v=a — A/B/C, scrub, space, ←/→
pnpm render         # out/harness-switch-{a,b,c}.mp4 and out/stills/
node render.mjs b   # one take
```

The render seeks the page frame by frame in headless Chromium (Playwright's
`chromium-headless-shell`; `npx playwright-core install chromium-headless-shell`
if missing) and pipes PNGs to `ffmpeg` (H.264, yuv420p, no audio).

The headline takes live in `VARIANTS`; the beats in `T` and `CAMERA`. The tile
data in `src/tiles.js` and the marks in `src/marks.js` are copied from
`apps/web`, so a redraw there wants a copy here.
