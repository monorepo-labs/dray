import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  ExternalLink,
  Globe,
  Maximize2,
  Minimize2,
  Plus,
  RotateCcw,
  RotateCw,
  Smartphone,
  SquareDashedMousePointer,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  activateTab,
  claimPresenter,
  closeTab,
  downloadChromium,
  listLocalServers,
  navigate,
  normalizeUrl,
  openDevTools,
  openInBrowser,
  pickElement,
  setPendingTab,
  useOpenError,
  setViewport,
  useBrowserTabs,
  useChromium,
  usePendingTab,
  usePicking,
  useViewport,
  VIEWPORT_PRESETS,
  type BrowserTab,
  type LocalServer,
  type Viewport,
} from "@/lib/browser";
import { chromiumBusy, chromiumPercent, describeChromium } from "@/lib/chromium";
import { cn } from "@/lib/utils";
import type { ChromiumStatus } from "@/types/events";

/// The element picker is built and parked: it works, but what it drops into
/// the composer wants a screenshot beside it before it is worth a button.
const PICKER = false;

/// The toolbar sits on the card surface, a step off the ghost hover fill at
/// best, so a hovered button there was invisible. A wash of the foreground
/// instead.
const TOOL_BTN = "hover:bg-foreground/10 aria-expanded:bg-foreground/10";

/// Every tooltip here opens upward. Below the toolbar is the page, a native
/// view nothing in the DOM can draw over, so a tooltip dropped there is a
/// tooltip nobody sees.
const TIP_SIDE = "top" as const;

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
  const pending = usePendingTab(sessionId);
  const current = pending ? null : (tabs.find((t) => t.active) ?? null);
  const viewport = useViewport(sessionId);
  const [deviceBar, setDeviceBar] = useState(false);
  const key = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const standingAside = mode === "panel" && fullOpen;
  // The empty state stands in for the page: nothing open, or a new tab
  // waiting for its first URL.
  const empty = !current;

  useEffect(() => {
    const stage = stageRef.current;
    if (!active || standingAside || !stage || empty) {
      claimPresenter(key, null);
      return;
    }
    const priority = mode === "full" ? 2 : 1;
    // The device frame is the page when one is set; the native view cannot
    // be clipped by the DOM, so the frame is sized to fit the stage below.
    const report = () => {
      const target = frameRef.current ?? stage;
      claimPresenter(key, { priority, sessionId, rect: target.getBoundingClientRect() });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(stage);
    if (frameRef.current) observer.observe(frameRef.current);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      claimPresenter(key, null);
    };
  }, [sessionId, key, active, mode, standingAside, empty, viewport]);

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
        pending={pending}
        mode={mode}
        deviceBar={deviceBar}
        onToggleDeviceBar={() => setDeviceBar((v) => !v)}
        onExpand={onExpand}
        onCollapse={onCollapse}
      />
      {deviceBar && (
        <DeviceBar sessionId={sessionId} viewport={viewport} onClose={() => setDeviceBar(false)} />
      )}
      <div
        ref={stageRef}
        className={cn(
          "relative min-h-0 flex-1 bg-background",
          viewport && !empty && "flex items-start justify-center overflow-hidden bg-surface-raised p-3",
        )}
      >
        {empty ? (
          <EmptyState sessionId={sessionId} />
        ) : viewport ? (
          // Clamped to the stage on both axes rather than scrolled: the page
          // is a native view, and a DOM scroll container cannot clip it.
          <div
            ref={frameRef}
            className="shrink-0 rounded-sm shadow-[0_0_0_1px_var(--border)]"
            style={{
              width: `min(${viewport.width}px, 100%)`,
              height: `min(${viewport.height}px, 100%)`,
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/// Tab strip and URL bar, coloured the way Chrome does it: the strip takes
/// the panel's own surface, the active tab and toolbar share the card, and
/// the URL field is cut into it, so which tab the bar belongs to is read
/// from colour alone. Palette rungs, never `--muted` or `--surface-well`:
/// those are washes with no hue, and in light mode they drew a grey bar
/// across a tinted page. The field's rung differs by mode because the ramp
/// does: `--surface-raised` is a clear step below the card in light and
/// all but the same colour in dark, where `--background` is the step.
function Chrome({
  sessionId,
  tabs,
  current,
  pending,
  mode,
  deviceBar,
  onToggleDeviceBar,
  onExpand,
  onCollapse,
}: {
  sessionId: string;
  tabs: BrowserTab[];
  current: BrowserTab | null;
  pending: boolean;
  mode: "panel" | "full";
  deviceBar: boolean;
  onToggleDeviceBar: () => void;
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const openError = useOpenError(sessionId);
  const inputRef = useRef<HTMLInputElement>(null);
  const picking = usePicking(sessionId);
  const url = current?.url ?? "";

  // A new tab is for typing into.
  useEffect(() => {
    if (pending) inputRef.current?.focus();
  }, [pending]);

  const open = (raw: string, newTab: boolean) => {
    const target = normalizeUrl(raw);
    if (!target) return;
    void openInBrowser(sessionId, target, newTab).catch(() => undefined);
  };

  const newTab = () => {
    setPendingTab(sessionId, true);
    setDraft("");
  };

  const swap = mode === "panel" ? onExpand : onCollapse;

  return (
    <div className="shrink-0 border-b border-border">
      {(tabs.length > 0 || pending) && (
        // Scrolls, but draws no bar: a strip of tabs is read by its tabs, and
        // a bar under them takes the height the tabs' own bottom edge needs.
        <div className="flex h-8 items-end gap-1 overflow-x-auto bg-sidebar px-2.5 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              active={tab.active && !pending}
              title={tab.error ? `${tab.error} — ${tab.url}` : tab.url}
              icon={<Favicon tab={tab} />}
              label={tab.error ? "Can't reach page" : tab.title || hostOf(tab.url)}
              onPick={() => {
                setPendingTab(sessionId, false);
                if (!tab.active) void activateTab(sessionId, tab.id);
              }}
              onClose={() => void closeTab(sessionId, tab.id)}
            />
          ))}
          {pending && (
            <TabButton
              active
              title="New tab"
              icon={<Globe className="size-3.5 shrink-0 opacity-60" />}
              label="New tab"
              onPick={() => inputRef.current?.focus()}
              onClose={() => setPendingTab(sessionId, false)}
            />
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="mb-0.5 shrink-0"
            aria-label="New tab"
            disabled={pending}
            onClick={newTab}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      )}
      <div className="flex h-9 items-center gap-0.5 bg-card px-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className={TOOL_BTN}
          aria-label="Back"
          disabled={!current?.canGoBack}
          onClick={() => void navigate(sessionId, "back")}
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className={TOOL_BTN}
          aria-label="Forward"
          disabled={!current?.canGoForward}
          onClick={() => void navigate(sessionId, "forward")}
        >
          <ArrowRight className="size-3.5" />
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={TOOL_BTN}
              aria-label={current?.loading ? "Stop" : "Reload"}
              disabled={!current}
              onClick={(e) =>
                void navigate(
                  sessionId,
                  current?.loading ? "stop" : e.shiftKey ? "hard_reload" : "reload",
                )
              }
            >
              {current?.loading ? <X className="size-3.5" /> : <RotateCw className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side={TIP_SIDE}>
            {current?.loading ? "Stop" : "Reload · ⇧ for hard reload"}
          </TooltipContent>
        </Tooltip>
        <form
          className="relative min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            open(draft ?? url, !current);
            setDraft(null);
            inputRef.current?.blur();
          }}
        >
          <input
            ref={inputRef}
            value={draft ?? url}
            placeholder="Search or enter a URL"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => setDraft(null)}
            className="h-7 w-full rounded-md bg-surface-raised px-2.5 font-mono dark:bg-background text-ui outline-none focus:ring-1 focus:ring-ring"
          />
        </form>
        {PICKER && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={picking ? "Cancel picking" : "Pick an element for the chat"}
                aria-pressed={picking}
                disabled={!current}
                className={cn(TOOL_BTN, picking && "bg-primary/15 text-primary")}
                onClick={() => void pickElement(sessionId, !picking)}
              >
                <SquareDashedMousePointer className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side={TIP_SIDE}>
              {picking ? "Click an element, or Esc" : "Pick an element for the chat"}
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Device size"
              aria-pressed={deviceBar}
              disabled={!current}
              className={cn(TOOL_BTN, deviceBar && "bg-foreground/10")}
              onClick={onToggleDeviceBar}
            >
              <Smartphone className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={TIP_SIDE}>Device size</TooltipContent>
        </Tooltip>
        {/* Plain buttons rather than a menu: a menu drops over the page, and
            the page is a native view nothing in the DOM can draw above. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={TOOL_BTN}
              aria-label="Developer tools"
              disabled={!current}
              onClick={() => void openDevTools(sessionId)}
            >
              <Bug className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={TIP_SIDE}>
            Developer tools
            <KbdGroup>
              <Kbd>⌥</Kbd>
              <Kbd>⌘</Kbd>
              <Kbd>I</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={TOOL_BTN}
              aria-label="Open in system browser"
              disabled={!current}
              onClick={() => void openUrl(url).catch(console.error)}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={TIP_SIDE}>Open in system browser</TooltipContent>
        </Tooltip>
        {swap && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={TOOL_BTN}
                onClick={swap}
                aria-label={mode === "panel" ? "Open full view" : "Back to the panel"}
              >
                {mode === "panel" ? <Maximize2 className="size-3.5" /> : <Minimize2 className="size-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side={TIP_SIDE}>
              {mode === "panel" ? "Open full view" : "Back to the panel"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {openError && (
        <p className="bg-card px-3 pb-1.5 text-ui text-destructive">{openError}</p>
      )}
    </div>
  );
}

function TabButton({
  active,
  title,
  icon,
  label,
  onPick,
  onClose,
}: {
  active: boolean;
  title: string;
  icon: React.ReactNode;
  label: string;
  onPick: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={title}
      onClick={onPick}
      onKeyDown={(e) => e.key === "Enter" && onPick()}
      className={cn(
        "group/tab flex h-7 w-40 min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-t-md px-2 text-ui",
        active
          ? "browser-tab-active bg-card text-foreground"
          : "text-muted-foreground hover:bg-card/50 hover:text-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        type="button"
        aria-label="Close tab"
        className="rounded p-0.5 opacity-0 hover:bg-muted group-hover/tab:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/// The page's icon, or a globe until one arrives or where the site has none.
function Favicon({ tab }: { tab: BrowserTab }) {
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

// Wide enough for four digits beside the placeholder, with the native
// stepper off — it sat on the placeholder and stepped by one pixel.
const SIZE_INPUT =
  "h-6 w-20 rounded-md bg-surface-raised dark:bg-background px-2 font-mono text-ui outline-none focus:ring-1 focus:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

/// Preset picker, free width and height, rotate. Responsive is the absence
/// of a viewport, so picking it clears rather than stores one.
function DeviceBar({
  sessionId,
  viewport,
  onClose,
}: {
  sessionId: string;
  viewport: Viewport | null;
  onClose: () => void;
}) {
  const apply = (next: Viewport | null) => setViewport(sessionId, next);
  const size = (axis: "width" | "height", raw: string) => {
    const n = Math.max(200, Math.min(4000, Math.round(Number(raw)) || 0));
    if (!n) return;
    apply({ preset: "custom", width: viewport?.width ?? n, height: viewport?.height ?? n, [axis]: n });
  };

  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-card px-2 text-ui">
      <select
        value={viewport?.preset ?? "responsive"}
        aria-label="Device preset"
        onChange={(e) => {
          const preset = VIEWPORT_PRESETS.find((p) => p.id === e.target.value);
          apply(preset ? { preset: preset.id, width: preset.width, height: preset.height } : null);
        }}
        className="h-6 rounded-md bg-surface-raised dark:bg-background px-1.5 text-ui outline-none focus:ring-1 focus:ring-ring"
      >
        <option value="responsive">Responsive</option>
        {VIEWPORT_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        {viewport?.preset === "custom" && <option value="custom">Custom</option>}
      </select>
      <input
        type="number"
        aria-label="Viewport width"
        value={viewport?.width ?? ""}
        placeholder="width"
        onChange={(e) => size("width", e.target.value)}
        className={SIZE_INPUT}
      />
      <span className="text-muted-foreground">×</span>
      <input
        type="number"
        aria-label="Viewport height"
        value={viewport?.height ?? ""}
        placeholder="height"
        onChange={(e) => size("height", e.target.value)}
        className={SIZE_INPUT}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        className={TOOL_BTN}
        aria-label="Rotate"
        disabled={!viewport}
        onClick={() =>
          viewport && apply({ preset: "custom", width: viewport.height, height: viewport.width })
        }
      >
        <RotateCcw className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn("ml-auto", TOOL_BTN)}
        aria-label="Close device toolbar"
        onClick={() => {
          apply(null);
          onClose();
        }}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

/// What to open when nothing is: this checkout's dev servers, the session's
/// own marked. Polled while on screen, since a server starting is the
/// moment the list is looked at.
function EmptyState({ sessionId }: { sessionId: string }) {
  const chromium = useChromium();
  // Nothing to open pages with yet: the download stands where the page would.
  if (chromium && chromium.state !== "ready") {
    return <ChromiumState status={chromium} />;
  }
  return <Servers sessionId={sessionId} />;
}

/// Chromium is fetched after install (see chromium.rs), and this is where the
/// reader watches it land. Failed and removed both offer the download; the
/// bar is only drawn while bytes are moving.
function ChromiumState({ status }: { status: ChromiumStatus }) {
  const percent = chromiumPercent(status);
  return (
    <div className="flex h-full items-center justify-center p-8 text-ui">
      <div className="flex w-full max-w-sm flex-col gap-3">
        <p className="text-muted-foreground">{describeChromium(status)}</p>
        {status.state === "downloading" && (
          <div className="h-1 overflow-hidden rounded-full bg-foreground/20">
            <div
              className="h-full bg-primary transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
        {!chromiumBusy(status) && (
          <div>
            <Button variant="outline" size="sm" onClick={() => void downloadChromium()}>
              {status.state === "failed" ? "Retry" : "Download Chromium"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Servers({ sessionId }: { sessionId: string }) {
  const [servers, setServers] = useState<LocalServer[]>([]);

  useEffect(() => {
    let live = true;
    const read = () =>
      void listLocalServers(sessionId)
        .then((list) => live && setServers(list))
        .catch(() => undefined);
    read();
    const timer = setInterval(read, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [sessionId]);

  const open = (url: string) => void openInBrowser(sessionId, url, true).catch(() => undefined);

  // One column, one left edge: the heading, the rows and the hint all start
  // at the same x, and the column as a whole sits in the middle.
  return (
    <div className="flex h-full items-center justify-center p-8 text-ui">
      <div className="flex w-full max-w-sm flex-col gap-4">
        {servers.length > 0 && (
          <section className="flex flex-col gap-0.5">
            <h3 className="px-2 pb-1 text-muted-foreground">Running locally</h3>
            {servers.map((s) => (
              <button
                key={s.port}
                type="button"
                onClick={() => open(`http://localhost:${s.port}`)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
              >
                <span className="font-mono">localhost:{s.port}</span>
                <span className="truncate text-muted-foreground">{s.process}</span>
                {s.mine && <span className="ml-auto text-muted-foreground">this session</span>}
              </button>
            ))}
          </section>
        )}
        <p className="px-2 text-muted-foreground">
          Search or enter a URL above, or open a link from the chat.
        </p>
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
