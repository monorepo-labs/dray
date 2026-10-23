"use client";

import { Orb as ThinkingOrb } from "@yogesharc/thinking-orbs";

/// The app's working indicator, the same orb the sidebar row draws in place of
/// its timestamp. `will-change` for the app's own reason: it redraws every frame,
/// and on a layer of its own that repaints the orb and nothing else.
///
/// `searching` at 18px is the browser tab's: a page the agent is driving
/// draws it in place of its favicon.
export default function Orb({
  state = "working",
  size,
  paused,
}: {
  state?: "working" | "searching";
  size?: number;
  paused?: boolean;
}) {
  return (
    <ThinkingOrb
      state={state}
      size={size}
      paused={paused}
      label={state === "working" ? "Working" : "Agent is using this tab"}
      className="text-foreground will-change-transform"
    />
  );
}
