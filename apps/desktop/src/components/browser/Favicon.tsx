import { useEffect, useState } from "react";

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
/// none. A tab or a history entry, which carries no error.
export default function Favicon({ tab }: { tab: { favicon: string; error?: string | null } }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [tab.favicon]);
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
