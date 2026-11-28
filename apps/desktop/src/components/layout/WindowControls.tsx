import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IS_MAC, IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/utils";

/// Whether this strip owns the window's buttons: a frameless Tauri window on
/// Windows or Linux. A Mac has traffic lights, and a browser pointed at
/// `dray-serve` has its own window and no native one for these to move.
const DRAWN = !IS_MAC && isTauri();

/// The room this strip takes from the window's right edge in a `padded`
/// header, plus one 8px gap: `--tabs-lead`'s mirror. Linux's 12px padding and
/// three 28px buttons 2px apart; Windows' three 44px buttons flush to the
/// edge. `AppShell` notches a page's sheet round it. `null` where nothing is drawn.
export const CONTROLS_TRAIL: string | null = DRAWN ? (IS_WINDOWS ? "8.75rem" : "6.75rem") : null;

/// Minimize, maximize and close, at the titlebar strip's right end. Windows and
/// Linux drop the window manager's own bar (`decorations: false` in their
/// configs), since keeping it drew two titlebars, and these stand in for its
/// buttons; a Mac's traffic lights float over that strip instead.
///
/// Close asks the window to close, which lands on the same `CloseRequested` the
/// manager's button raised, so the quit dialog still guards it. The row's deep
/// drag region lets each `<button>` keep its click, and the gaps between them
/// still drag the window.
///
/// `padded` says the header pads its right edge with `px-3`, which Windows'
/// flush caption buttons pull back out of; a header with no padding would
/// push Close past the window's edge.
export default function WindowControls({ padded = false }: { padded?: boolean }) {
  const maximized = useMaximized();
  if (!DRAWN) return null;

  const win = getCurrentWindow();
  // Windows caption buttons sit flat against the frame: full titlebar height,
  // 44px wide, a soft hover fill and a red one on Close. Linux keeps the small
  // round ghost buttons it has always had. `!` wins over icon-sm's size and
  // ghost's radius and hover fill.
  const shape = IS_WINDOWS ? "w-11! h-(--titlebar-h)! rounded-none!" : "";
  const hover = IS_WINDOWS ? "hover:bg-foreground/10! dark:hover:bg-foreground/10!" : "";
  const closeHover = IS_WINDOWS
    ? "hover:bg-[#e81123]! dark:hover:bg-[#e81123]! hover:text-white! dark:hover:text-white!"
    : "";
  const button = "shrink-0 text-muted-foreground transition-colors hover:text-foreground";

  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", IS_WINDOWS && "gap-0", IS_WINDOWS && padded && "-mr-3")}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Minimize"
        onClick={() => void win.minimize()}
        className={cn(button, shape, hover)}
      >
        <Minus className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => void win.toggleMaximize()}
        className={cn(button, shape, hover)}
      >
        {maximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Close"
        onClick={() => void win.close()}
        className={cn(button, shape, closeHover)}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

/// Whether the window is maximized, re-read on every resize since there is no
/// event of its own. Never asked where nothing draws it.
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!DRAWN) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    const read = async () => {
      const value = await win.isMaximized();
      if (!cancelled) setMaximized(value);
    };
    void read();
    void win.onResized(read).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return maximized;
}
