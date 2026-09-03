import { ArrowLeft, ArrowRight, Maximize2, Minimize2, Plus, RotateCw, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  activateTab,
  claimPresenter,
  closeTab,
  navigate,
  normalizeUrl,
  openInBrowser,
  useBrowserTabs,
  type BrowserTab,
} from "@/lib/browser";
import { cn } from "@/lib/utils";

/// The session's browser: tab strip, URL bar, navigation, and the page.
///
/// Two mounts of one component. The right panel's Browser tab is where it
/// lives; the main column's is the full view, reached by the expand button,
/// and while that is open the panel says so instead of drawing a second copy.
///
/// The page is a native view Chromium draws into the window above the
/// webview; nothing here renders it. The stage below reports its rect and
/// Rust moves the view onto it. The full view outranks the panel, so should
/// both ever be on screen the page lands in the full view.
export default function BrowserPane({
  sessionId,
  active,
  mode,
  fullOpen = false,
  onExpand,
  onCollapse,
}: {
  sessionId: string;
  active: boolean;
  mode: "panel" | "full";
  /// The full view is showing, so the panel mount stands aside.
  fullOpen?: boolean;
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const tabs = useBrowserTabs(sessionId);
  const current = tabs.find((t) => t.active) ?? null;
  const key = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const standingAside = mode === "panel" && fullOpen;

  useEffect(() => {
    const stage = stageRef.current;
    if (!active || standingAside || !stage || tabs.length === 0) {
      claimPresenter(key, null);
      return;
    }
    const priority = mode === "full" ? 2 : 1;
    const report = () =>
      claimPresenter(key, { priority, sessionId, rect: stage.getBoundingClientRect() });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(stage);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      claimPresenter(key, null);
    };
  }, [sessionId, key, active, mode, standingAside, tabs.length]);

  if (standingAside) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-ui text-muted-foreground">
        <span>Open in the full view.</span>
        {onCollapse && (
          <Button variant="outline" size="sm" onClick={onCollapse}>
            Bring it back here
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Chrome
        sessionId={sessionId}
        tabs={tabs}
        current={current}
        mode={mode}
        onExpand={onExpand}
        onCollapse={onCollapse}
      />
      <div ref={stageRef} className="relative min-h-0 flex-1 bg-background">
        {tabs.length === 0 && (
          <div className="flex h-full items-center justify-center p-8 text-center text-ui text-muted-foreground">
            Enter a URL or a search above, or open a link from the chat.
          </div>
        )}
      </div>
    </div>
  );
}

/// Tab strip and URL bar, coloured the way Chrome does it: the strip and the
/// URL field take the panel's own surface, and the active tab and toolbar
/// share the raised one, so which tab the bar belongs to is read from colour
/// alone. `bg-muted` rather than `bg-background`, which is the panel's colour
/// in most palettes and drew all three the same.
function Chrome({
  sessionId,
  tabs,
  current,
  mode,
  onExpand,
  onCollapse,
}: {
  sessionId: string;
  tabs: BrowserTab[];
  current: BrowserTab | null;
  mode: "panel" | "full";
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const url = current?.url ?? "";

  const open = (raw: string, newTab: boolean) => {
    const target = normalizeUrl(raw);
    if (!target) return;
    void openInBrowser(sessionId, target, newTab).catch(console.error);
  };

  const swap = mode === "panel" ? onExpand : onCollapse;

  return (
    <div className="shrink-0 border-b border-border">
      {tabs.length > 0 && (
        // Scrolls, but draws no bar: a strip of tabs is read by its tabs, and
        // a bar under them takes the height the tabs' own bottom edge needs.
        <div className="flex h-8 items-end gap-1 overflow-x-auto bg-sidebar px-2.5 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.active}
              tabIndex={0}
              title={tab.url}
              onClick={() => !tab.active && void activateTab(sessionId, tab.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !tab.active) void activateTab(sessionId, tab.id);
              }}
              className={cn(
                "group/tab flex h-7 w-40 min-w-0 shrink-0 cursor-default items-center gap-1 rounded-t-md px-2 text-ui",
                tab.active
                  ? "browser-tab-active bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{tab.title || hostOf(tab.url)}</span>
              <button
                type="button"
                aria-label="Close tab"
                className="rounded p-0.5 opacity-0 hover:bg-muted group-hover/tab:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(sessionId, tab.id);
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="icon-sm"
            className="mb-0.5 shrink-0"
            aria-label="New tab"
            onClick={() => open("about:blank", true)}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      )}
      <div className="flex h-9 items-center gap-0.5 bg-muted px-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          disabled={!current?.canGoBack}
          onClick={() => void navigate(sessionId, "back")}
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          disabled={!current?.canGoForward}
          onClick={() => void navigate(sessionId, "forward")}
        >
          <ArrowRight className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={current?.loading ? "Stop" : "Reload"}
          disabled={!current}
          onClick={() => void navigate(sessionId, current?.loading ? "stop" : "reload")}
        >
          {current?.loading ? <X className="size-3.5" /> : <RotateCw className="size-3.5" />}
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            open(draft ?? url, !current);
            setDraft(null);
            (e.currentTarget.elements[0] as HTMLInputElement | undefined)?.blur();
          }}
        >
          <input
            value={draft ?? url}
            placeholder="Search or enter a URL"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => setDraft(null)}
            // `--sidebar` is transparent, so the field wants the inset well
            // to read dark against the raised toolbar.
            className="h-7 w-full rounded-md bg-surface-well px-2.5 font-mono text-ui outline-none focus:ring-1 focus:ring-ring"
          />
        </form>
        {swap && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={swap}
                aria-label={mode === "panel" ? "Open full view" : "Back to the panel"}
              >
                {mode === "panel" ? <Maximize2 className="size-3.5" /> : <Minimize2 className="size-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {mode === "panel" ? "Open full view" : "Back to the panel"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "New tab";
  }
}
