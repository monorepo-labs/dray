/// The preview's two buttons: a lit light keycap and a plain dark one. Shared
/// by the hero and the closing call so the page asks the same way twice.
const BASE =
  "inline-flex h-10 items-center gap-2 rounded-[10px] border px-4 text-sm font-medium transition-colors [&_svg]:size-4";

export const LIGHT_BUTTON = `${BASE} border-white/80 bg-gradient-to-b from-white to-[#e6e6eb] text-[#0b0b0f] shadow-[inset_0_1px_0_#fff,0_1px_2px_rgba(0,0,0,.25),0_10px_28px_-10px_rgba(0,0,0,.6)] hover:to-[#f2f2f5]`;

export const DARK_BUTTON = `${BASE} border-[0.5px]! border-white/10 bg-[#0e0e11] text-white shadow-[0_10px_28px_-10px_rgba(0,0,0,.7)] hover:bg-[#18181c]`;

/// Frosted glass on a squircle: a translucent fill, a lit top edge and a faint
/// inner rim. `corner-shape` falls back to plain rounding where unsupported.
export const GLASS_ICON_BUTTON =
  "grid size-9 place-items-center rounded-full border border-white/15 bg-gradient-to-t from-white/[0.14] to-white/[0.03] text-white/80 shadow-[inset_0_1px_0_rgb(255_255_255/.3),inset_0_-1px_0_rgb(255_255_255/.06),0_10px_24px_-10px_rgb(0_0_0/.7)] backdrop-blur-xl transition-colors hover:from-white/[0.2] hover:text-white";

/// The light keycap at nav size.
export const SMALL_LIGHT_BUTTON = LIGHT_BUTTON.replace("h-10", "h-8").replace("px-4", "px-3").replace("text-sm", "text-[13px]").replace("[&_svg]:size-4", "[&_svg]:size-3.5");
