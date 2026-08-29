import { AppWindow } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ExternalApp } from "@/types/events";

/// An installed app's own icon, or a glyph where the bundle keeps none as an
/// `.icns`.
///
/// `aria-hidden` and no `alt`: every place this is drawn carries the app's name
/// beside it or on a tooltip, so a screen reader reading the mark as well would
/// say the app twice.
export default function AppIcon({
  app,
  className,
}: {
  app: ExternalApp;
  className?: string;
}) {
  if (!app.icon) return <AppWindow className={cn("shrink-0", className)} />;
  return <img src={app.icon} alt="" aria-hidden className={cn("shrink-0", className)} />;
}
