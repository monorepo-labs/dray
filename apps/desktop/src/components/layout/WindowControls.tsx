import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IS_MAC } from "@/lib/platform";

/// Whether this strip owns the window's buttons: a Linux app window. A Mac has
/// traffic lights, and a browser pointed at `dray-serve` has its own window and
/// no native one for these to move.
const DRAWN = !IS_MAC && isTauri();

/// Minimize, maximize and close, at the titlebar strip's right end — in the
/// Linux app alone. The Mac's traffic lights float over that strip; Linux drops
/// the window manager's own bar instead (`set_decorations(false)` in lib.rs),
/// since keeping it drew two titlebars, and these stand in for its buttons.
///
/// Close asks the window to close, which lands on the same `CloseRequested` the
/// manager's button raised, so the quit dialog still guards it.
export default function WindowControls() {
  const maximized = useMaximized();
  if (!DRAWN) return null;

  const win = getCurrentWindow();
  const button = "shrink-0 text-muted-foreground transition-colors hover:text-foreground";

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Minimize"
        onClick={() => void win.minimize()}
        className={button}
      >
        <Minus className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => void win.toggleMaximize()}
        className={button}
      >
        {maximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Close"
        onClick={() => void win.close()}
        className={button}
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
