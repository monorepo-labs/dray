import { Globe } from "lucide-react";
import { useEffect, useState } from "react";

import type { BrowserTab } from "@/lib/browser";

/// The page's icon, or a globe until one arrives or where the site has none.
export default function Favicon({ tab }: { tab: BrowserTab }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [tab.favicon]);
  if (!tab.favicon || broken || tab.error) {
    return <Globe className="size-3.5 shrink-0 opacity-60" />;
  }
  return (
    <img
      src={tab.favicon}
      alt=""
      className="size-3.5 shrink-0 rounded-[2px]"
      onError={() => setBroken(true)}
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
