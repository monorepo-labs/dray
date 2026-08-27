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
export default function Orb(props: Omit<ThinkingOrbProps, "theme">) {
  const { resolvedMode } = useTheme();
  return <ThinkingOrb theme={resolvedMode} {...props} />;
}
