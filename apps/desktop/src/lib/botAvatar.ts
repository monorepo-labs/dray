import type { BotAvatar } from "@/types/events";

/// Blobatar's ten silhouettes, each pinned by a `traits.shape` position.
///
/// The library picks a shape from cumulative cut points over [0, 1) (round
/// < 0.22, organic < 0.48, boxy < 0.6, capsule < 0.7, nub < 0.79, cloud < 0.86,
/// droplet < 0.915, hexagon < 0.95, sun < 0.98, triangle < 1); each position
/// here is the middle of its band, so a nudge to a cut point in a later minor
/// still lands on the same shape. The bot stores the name, never the number.
///
/// The droplet is left out on purpose, so no face ever takes it: a bot saved
/// with it before draws the first shape instead.
export const SHAPES = [
  { name: "round", position: 0.11 },
  { name: "organic", position: 0.35 },
  { name: "boxy", position: 0.54 },
  { name: "capsule", position: 0.65 },
  { name: "nub", position: 0.745 },
  { name: "cloud", position: 0.825 },
  { name: "hexagon", position: 0.9325 },
  { name: "sun", position: 0.965 },
  { name: "triangle", position: 0.99 },
] as const;

/// The colours offered, as hue degrees. Hue alone keeps the library's own
/// eye-contrast guarantee, which a palette override would bypass.
export const HUES = [
  { name: "Red", hue: 25 },
  { name: "Orange", hue: 50 },
  { name: "Amber", hue: 80 },
  { name: "Green", hue: 145 },
  { name: "Teal", hue: 185 },
  { name: "Blue", hue: 250 },
  { name: "Purple", hue: 295 },
  { name: "Pink", hue: 340 },
] as const;

export const DEFAULT_AVATAR: BotAvatar = { shape: "cloud", hue: 250 };

/// The Blobatar props that draw `avatar`. Undefined for a bot with no pick;
/// `BotAvatar` seeds one through `seededAvatar` rather than reach that.
export function avatarProps(
  avatar: BotAvatar | null | undefined,
): { traits: { shape: number }; hue: number; tone: number } | undefined {
  if (!avatar) return undefined;
  const shape = SHAPES.find((s) => s.name === avatar.shape);
  return { traits: { shape: shape?.position ?? SHAPES[0].position }, hue: avatar.hue, tone: TONE };
}

/// The swatch every picked face takes, pale (0) to ink (1). Left to the seed,
/// most names land on a pale one and the colour picked barely shows.
const TONE = 0.55;

/// A swatch's own colour, near what Blobatar paints at a mid tone.
export function swatch(hue: number): string {
  return `oklch(0.68 0.16 ${hue})`;
}

/// A face for something with no pick of its own, such as a task a bot started:
/// a shape and colour from the seed, drawn at the picked faces' tone, since
/// the library's own seeding lands on a pale swatch that vanishes on a chip.
export function seededAvatar(seed: string): BotAvatar {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { shape: SHAPES[hash % SHAPES.length].name, hue: HUES[(hash >>> 8) % HUES.length].hue };
}
