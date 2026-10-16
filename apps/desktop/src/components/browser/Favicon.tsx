import { useEffect, useState } from "react";

import Orb from "@/components/Orb";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDriven } from "@/lib/browser";

/// A mask rather than an `<img>`, so the mark takes the text colour — the
/// theme's, and the URL row's tint over a dark page.
const MARK = {
  maskImage: "url(/assets/icon-square-frame.svg)",
  WebkitMaskImage: "url(/assets/icon-square-frame.svg)",
  maskSize: "contain",
  WebkitMaskSize: "contain",
  maskRepeat: "no-repeat",
  WebkitMaskRepeat: "no-repeat",
} as const;

/// Dray's mark, for a page with no icon of its own.
function FallbackIcon() {
  return <span aria-hidden className="size-3.5 shrink-0 bg-current opacity-60" style={MARK} />;
}

/// The page's icon, or Dray's mark until one arrives or where the site has
/// none. A tab or a history entry, which carries no error and no id. A tab the
/// agent is driving draws the orb instead, so the reader knows their clicks
/// would land in the middle of its work.
export default function Favicon({
  tab,
}: {
  tab: { id?: number; favicon: string; error?: string | null };
}) {
  const [broken, setBroken] = useState(false);
  const driven = useDriven(tab.id);
  useEffect(() => setBroken(false), [tab.favicon]);
  // The sphere fills only 80% of its box and its edge dots fade, so it is
  // drawn at 18px and pulled back into the favicon's 14px slot. The label
  // stays fixed, since the orb remounts whenever it changes; what the agent
  // is doing goes in the tooltip.
  if (driven) {
    return (
      <Tooltip delayDuration={700}>
        <TooltipTrigger asChild>
          {/* Stopped here, or the tab's own tooltip opens over this one. */}
          <span className="-m-0.5 flex shrink-0" onPointerMove={(e) => e.stopPropagation()}>
            <Orb state="searching" size={18} label="Agent is using this tab" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{driven}</TooltipContent>
      </Tooltip>
    );
  }
  // `data:,` is how a page says it has no icon (example.com does), and WebKit
  // draws its broken-image box for it with neither `load` nor `error` firing.
  if (!tab.favicon || /^data:[^,]*,$/.test(tab.favicon) || broken || tab.error) {
    return <FallbackIcon />;
  }
  return (
    <img
      src={tab.favicon}
      alt=""
      className="size-3.5 shrink-0 rounded-[2px]"
      onError={() => setBroken(true)}
      // An icon that decodes to nothing draws the same box.
      onLoad={(e) => e.currentTarget.naturalWidth === 0 && setBroken(true)}
    />
  );
}

/// A page's host, for a tab whose page has no title yet.
export function hostOf(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "New tab";
  }
}
