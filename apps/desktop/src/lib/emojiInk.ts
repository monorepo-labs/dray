/// Where an emoji's ink sits, for centring it by eye rather than by its box.
///
/// Each emoji font places its glyphs at its own spot in the em box, and every
/// glyph at a different one: one heart sits low, another face high. A fixed
/// nudge per emoji is then right on one platform alone, so the ink is measured
/// where it is drawn, once per emoji and font.

export type Box = { left: number; top: number; right: number; bottom: number };

/// Alpha at or under this is anti-aliasing haze, not ink.
const HAZE = 24;

/// The bounds of the ink in an RGBA buffer `width` pixels wide, or null where
/// nothing was drawn. Edges are exclusive.
export function inkBox(rgba: ArrayLike<number>, width: number, height: number): Box | null {
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] <= HAZE) continue;
      if (x < left) left = x;
      if (x >= right) right = x + 1;
      if (y < top) top = y;
      if (y >= bottom) bottom = y + 1;
    }
  }
  return right > left ? { left, top, right, bottom } : null;
}

const measured = new Map<string, Box | null>();

/// `text`'s ink in CSS pixels, relative to where it starts on its baseline (so
/// `top` is negative), drawn in `font` as a canvas takes it. Null where the
/// canvas draws nothing, as a headless one may.
export function inkOf(text: string, font: string): Box | null {
  const key = `${font}\u0000${text}`;
  if (measured.has(key)) return measured.get(key)!;
  const size = Math.ceil(parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? "16"));
  // Device pixels, so a half-pixel offset is seen on a Retina screen.
  const scale = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const side = size * 4 * scale;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = side;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let box: Box | null = null;
  if (ctx) {
    ctx.scale(scale, scale);
    ctx.font = font;
    ctx.textBaseline = "alphabetic";
    // Origin a size in from the left and three down, so overhang either way is kept.
    ctx.fillText(text, size, size * 3);
    const ink = inkBox(ctx.getImageData(0, 0, side, side).data, side, side);
    if (ink) {
      box = {
        left: ink.left / scale - size,
        right: ink.right / scale - size,
        top: ink.top / scale - size * 3,
        bottom: ink.bottom / scale - size * 3,
      };
    }
  }
  measured.set(key, box);
  return box;
}

/// How far to move a text box `width` by `height`, its baseline `baseline` from
/// its top, so `ink` (from [inkOf]) sits at the box's centre. Rounded to half a
/// pixel, which a Retina screen draws and a plain one does not blur.
export function centring(ink: Box, width: number, height: number, baseline: number): { x: number; y: number } {
  const half = (n: number) => Math.round(n * 2) / 2;
  return {
    x: half(width / 2 - (ink.left + ink.right) / 2),
    y: half(height / 2 - (baseline + (ink.top + ink.bottom) / 2)),
  };
}
