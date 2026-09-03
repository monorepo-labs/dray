import { ThinkingOrb, type ThinkingOrbProps } from "thinking-orbs";

import { useTheme } from "@/hooks/useTheme";

/// The thinking orb, told which mode it is being drawn in.
///
/// A wrapper rather than the prop repeated at each call site, because the orb's own
/// `auto` cannot work here and every site would otherwise have to remember why: `auto`
/// reads `data-theme="dark|light"`, and this app stamps a *palette* name there
/// (`default`, `gruvbox`) with the mode on `data-mode`. So every orb was pinned
/// `theme="dark"`, which was true until light mode existed and then left a near-white
/// orb invisible on a light page — in six places at once, since the pin had been
/// copied along with the element.
///
/// `resolvedMode`, not `mode`: `system` is not a thing the orb can draw.
///
/// `will-change: transform` gives the canvas a compositing layer of its own.
/// It redraws every animation frame, and a small canvas paints into its
/// parent's layer — so each orb in a sidebar row was repainting the whole
/// document's tile set at animation rate, which on WebKit fed a leak of
/// retired backing stores at ~1GB per hour of use (DRA-159). On its own layer
/// a frame repaints a 40×40 backing store and nothing else.
export default function Orb({ style, ...props }: Omit<ThinkingOrbProps, "theme">) {
  const { resolvedMode } = useTheme();
  return <ThinkingOrb theme={resolvedMode} style={{ willChange: "transform", ...style }} {...props} />;
}
