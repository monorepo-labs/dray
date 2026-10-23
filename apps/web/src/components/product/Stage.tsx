import type { CSSProperties } from "react";

/// The hero's own backdrop, and the only colour on the page: the page's black
/// at the top, deepening through navy into electric blue at the foot.
export const HERO_BG: CSSProperties = {
  backgroundImage: "linear-gradient(180deg, oklch(0.115 0 0), #060C3A 30%, #13259C 68%, #1C33A3)",
};

/// The feature cards' backdrop: deep blue at the top into the hero's bright
/// blue at the foot, bright enough to pull the eye off the black page.
export const CARD_BG: CSSProperties = {
  backgroundImage: "linear-gradient(180deg, #0B1660, #2A48E8)",
};

/// The Island cards' backdrop, the card gradient upside down: bright at the top.
export const CARD_BG_FLIPPED: CSSProperties = { backgroundImage: String(CARD_BG.backgroundImage).replace("180deg", "0deg") };

/// The gradients page's graphite blue: the page's black into a blue-grey.
/// The crew and remote servers sections' band.
export const GRAPHITE_BG: CSSProperties = {
  backgroundImage: "linear-gradient(180deg, oklch(0.115 0 0), #111C2E)",
};

/// The hero's blue turned upside down: electric blue at the top, black at the
/// foot. The Island screen's wallpaper, under the notch.
export const HERO_BG_FLIPPED: CSSProperties = {
  backgroundImage: String(HERO_BG.backgroundImage).replace("180deg", "0deg"),
};

/// A light catching the window's top edge, brightest just left of centre.
export const RIM_LIGHT: CSSProperties = {
  background: "linear-gradient(90deg, transparent, #8fb0ff 15%, #fff 40%, #fff 55%, #9fbcff 75%, transparent)",
  // drop-shadow, not box-shadow: it follows the line's own fade, where a box
  // shadow lights the full rectangle and leaves the faded ends reading dark.
  filter:
    "drop-shadow(0 0 3px rgb(170 200 255)) drop-shadow(0 0 12px rgb(70 120 255)) drop-shadow(0 -4px 36px rgb(50 100 255 / .7))",
};
