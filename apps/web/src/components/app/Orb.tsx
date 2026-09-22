"use client";

import { ThinkingOrb, type ThinkingOrbProps } from "thinking-orbs";

/// The app's working indicator, the same canvas the sidebar row draws in place
/// of its timestamp.
///
/// `theme` is pinned rather than left at `auto`: the package reads
/// `data-theme="dark|light"` and this site sets no such attribute, so `auto`
/// would resolve against nothing. The site is dark-only anyway.
export default function Orb({ style, ...props }: Omit<ThinkingOrbProps, "theme">) {
  return (
    <ThinkingOrb
      theme="dark"
      state="listening"
      size={20}
      style={{ willChange: "transform", ...style }}
      {...props}
    />
  );
}
