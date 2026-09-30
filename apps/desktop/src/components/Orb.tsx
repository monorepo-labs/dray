import { Orb as ThinkingOrb } from "@yogesharc/thinking-orbs";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/// The thinking orb, in the page's ink and on a layer of its own.
///
/// It draws in `currentColor`, and `text-foreground` is the default because most
/// sites sit it in a muted timestamp slot, where inheriting would dim the one
/// thing in the row that says work is happening.
///
/// `will-change: transform` gives the svg a compositing layer of its own. It
/// redraws every animation frame, and a small element paints into its parent's
/// layer — so each orb in a sidebar row was repainting the whole document's tile
/// set at animation rate, which on WebKit fed a leak of retired backing stores at
/// ~1GB per hour of use (DRA-159). On its own layer a frame repaints the orb and
/// nothing else.
export default function Orb({ className, ...props }: ComponentProps<typeof ThinkingOrb>) {
  return <ThinkingOrb className={cn("text-foreground will-change-transform", className)} {...props} />;
}
