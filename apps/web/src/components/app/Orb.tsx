"use client";

import { Orb as ThinkingOrb } from "@yogesharc/thinking-orbs";

/// The app's working indicator, the same orb the sidebar row draws in place of
/// its timestamp. `will-change` for the app's own reason: it redraws every frame,
/// and on a layer of its own that repaints the orb and nothing else.
export default function Orb() {
  return <ThinkingOrb state="working" label="Working" className="text-foreground will-change-transform" />;
}
