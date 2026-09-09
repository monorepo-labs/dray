/// Making the tracker's own colours readable on a light background.
///
/// Linear's state palette is picked for a dark surface — "In Progress" is
/// `#f2c94c` and the default "Todo" is `#e2e2e2` — and both all but disappear on
/// a light one. This is the one place that is corrected, so a workspace's custom
/// state colour gets the same treatment as Linear's own.
///
/// Its own file rather than a helper inside [IssueStateIcon], because being
/// wrong here is invisible on screen: a slightly-off exponent still produces a
/// plausible colour. That is the bar this repo files pure logic under test for.
///
/// [IssueStateIcon]: ../components/IssueStateIcon.tsx

/// The most luminous a state mark may be in light mode.
///
/// WCAG's floor for a graphical object is 3:1, which against white works out at
/// a relative luminance of `1.05/3 - 0.05`.
const MAX_LIGHT_LUMINANCE = 0.3;

/// One sRGB channel with gamma removed. What luminance is summed over.
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/// `#rrggbb` as three bytes, or `null` for anything else — a named colour, a
/// short hex, an empty string. Unparseable is left alone rather than guessed at.
function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;

  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminanceOf([r, g, b]: [number, number, number]): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/// WCAG relative luminance, 0 for black and 1 for white. `null` for a colour
/// this module cannot read.
export function luminance(color: string): number | null {
  const rgb = parseHex(color);
  return rgb && luminanceOf(rgb);
}

/// How many passes the correction below gets. It converges geometrically, so
/// three is already past the rounding, and the bound is only here so a colour
/// that somehow refuses to fall cannot spin.
const MAX_PASSES = 8;

/// The tracker's colour, dark enough to read on the mode's own background.
///
/// **The hue is kept and the lightness is spent.** A workspace that paints "In
/// Review" green has to read green here — that is the whole reason these marks
/// carry the tracker's colour at all — so all three channels are scaled by one
/// factor rather than a colour of ours being substituted.
///
/// **Applied until it lands, not once.** Luminance goes *roughly* as the channel
/// to the 2.4, which makes one correction a good guess and not an answer: sRGB's
/// curve has a linear toe and an offset, so a single pass left Linear's own
/// `#f2c94c` at 0.315 against a 0.3 floor — still short of 3:1, and invisibly
/// so. Each pass re-measures the *rounded* channels, which is what is returned,
/// so the colour that was checked is the colour that is drawn.
///
/// Dark mode is returned untouched: the palette was designed for it, and
/// correcting a colour that already reads would only make the app disagree with
/// the tracker beside it for nothing.
export function readableStateColor(color: string, light: boolean): string {
  if (!light) return color;

  const rgb = parseHex(color);
  if (!rgb || luminanceOf(rgb) <= MAX_LIGHT_LUMINANCE) return color;

  let scale = 1;
  let out = rgb;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const l = luminanceOf(out);
    if (l <= MAX_LIGHT_LUMINANCE) break;

    scale *= (MAX_LIGHT_LUMINANCE / l) ** (1 / 2.4);
    out = rgb.map((channel) => Math.round(channel * scale)) as [number, number, number];
  }

  return `#${out.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
