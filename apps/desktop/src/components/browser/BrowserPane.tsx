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
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import RecordingNotice from "@/components/browser/RecordingNotice";
import ShortcutKeys from "@/components/ShortcutKeys";
import { Button, buttonVariants } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDragReorder } from "@/hooks/useDragReorder";
import {
  activateTab,
  claimPresenter,
  closeTab,
  downloadChromium,
  listLocalServers,
  moveTab,
  navigate,
  normalizeUrl,
  openDevTools,
  openInBrowser,
  pickElement,
  removeCustomDevice,
  saveCustomDevice,
  setPendingTab,
  setResponsive,
  useOpenError,
  useResponsive,
  setViewport,
  snapshotPainted,
  useBrowserSnapshot,
  useBrowserTabs,
  useChromium,
  useCustomDevices,
  usePendingTab,
  usePicking,
  useRecording,
  useViewport,
  VIEWPORT_PRESETS,
  type Snapshot as BrowserSnapshot,
  type BrowserTab,
  type Device,
  type LocalServer,
  type Viewport,
} from "@/lib/browser";
import { chromiumBusy, chromiumPercent, describeChromium } from "@/lib/chromium";
import { useWindowFocused } from "@/lib/focus";
import { zoomLevel } from "@/lib/zoom";
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
  const tabs = useBrowserTabs(sessionId) ?? [];
  const pending = usePendingTab(sessionId);
  const current = pending ? null : (tabs.find((t) => t.active) ?? null);
  const viewport = useViewport(sessionId);
  // Responsive with no size typed is a flag; with one, it is a viewport.
  const responsive = useResponsive(sessionId) || viewport?.preset === "responsive";
  const snapshot = useBrowserSnapshot(sessionId);
  const recording = useRecording(sessionId);
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

  // The page's size in responsive mode, which is what Save keeps. In page
  // pixels: the view is placed in window points, so the app's own zoom
  // scales what the page lays out at.
  const [room, setRoom] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const read = () =>
      setRoom({
        width: Math.round(stage.clientWidth * zoomLevel()),
        height: Math.round(stage.clientHeight * zoomLevel()),
      });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [standingAside]);

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
        onExpand={onExpand}
        onCollapse={onCollapse}
      />
      {!empty &&
        (responsive ? (
          <SaveSizeBar key={sessionId} sessionId={sessionId} size={viewport ?? room} />
        ) : (
          // Keyed on session and device, so a delete question never carries to
          // another; the pane stays mounted across session switches.
          viewport && <SizeBar key={`${sessionId}:${viewport.preset}`}sessionId={sessionId} viewport={viewport} />
        ))}
      <div
        ref={stageRef}
        className={cn(
          "relative min-h-0 flex-1 bg-background",
          viewport && !empty && "flex items-start justify-center overflow-hidden bg-surface-raised p-3",
        )}
      >
        {empty ? (
          <EmptyState sessionId={sessionId} active={active} />
        ) : viewport ? (
          // Clamped to the stage on both axes rather than scrolled or scaled:
          // the page is a native view the DOM can neither clip nor shrink,
          // and Chromium would not paint reliably under either (#332).
          <div
            ref={frameRef}
            className="relative shrink-0 rounded-sm shadow-[0_0_0_1px_var(--border)]"
            style={{
              // Device sizes are page pixels, which is what the native view is
              // placed in; the app's own zoom would scale them a second time.
              width: `min(${viewport.width / zoomLevel()}px, 100%)`,
              height: `min(${viewport.height / zoomLevel()}px, 100%)`,
            }}
          >
            <Snapshot of={snapshot} />
          </div>
        ) : (
          <Snapshot of={snapshot} />
        )}
        {recording && !empty && <RecordingNotice />}
      </div>
    </div>
  );
}

/// Stands in for the native view while a modal has it hidden, and while a
/// shot is under way. Fills the same rect the view did, so the capture
/// lands with no scaling.
///
/// **A shot draws this and nothing else.** A scrim and a camera sat over it
/// for a while, and they were the only thing anybody could see: the still
/// is the page, pixel for pixel, so freezing it is invisible by
/// construction and anything drawn on top is a flash where there was none.
/// A screenshot is not an event the reader has to be told about — they
/// asked for it, and the file lands in the transcript.
function Snapshot({ of }: { of: BrowserSnapshot | null }) {
  if (!of?.url) return null;
  return (
    <img
      src={of.url}
      alt=""
      className="absolute inset-0 h-full w-full"
      onLoad={(e) => {
        void e.currentTarget
          .decode()
          .catch(() => undefined)
          .then(() => snapshotPainted(of));
      }}
    />
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
  onExpand,
  onCollapse,
}: {
  sessionId: string;
  tabs: BrowserTab[];
  current: BrowserTab | null;
  pending: boolean;
  mode: "panel" | "full";
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const openError = useOpenError(sessionId);
  const inputRef = useRef<HTMLInputElement>(null);
  const picking = usePicking(sessionId);
  // The reader cannot change tabs mid-recording: the agent's next verb goes to
  // whichever tab is active, and a switch here would send it somewhere else.
  // The agent's own tab verbs stay open, since a flow may cross tabs.
  const recording = useRecording(sessionId);
  const url = current?.url ?? "";
  const reorder = useDragReorder(
    tabs,
    (tab) => tab.id,
    (tab, _delta, to) => moveTab(sessionId, tab.id, to),
    "x",
  );

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
        <div
          ref={reorder.list}
          className="flex h-8 items-end gap-1 overflow-x-auto bg-sidebar px-2.5 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {reorder.shown.map((tab, i) => (
            <TabButton
              key={tab.id}
              // Not mid-recording, when the agent's tab numbers must hold still.
              onPointerDown={recording ? undefined : (e) => reorder.start(e, i)}
              transform={reorder.offset(i)}
              held={reorder.drag?.from === i}
              gliding={!!reorder.drag && reorder.drag.from !== i}
              active={tab.active && !pending}
              title={tab.error ? `${tab.error} — ${tab.url}` : tab.url}
              icon={<Favicon tab={tab} />}
              label={tab.error ? "Can't reach page" : tab.title || hostOf(tab.url)}
              locked={recording}
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="mb-0.5 shrink-0"
                aria-label="New tab"
                disabled={pending || recording}
                onClick={newTab}
              >
                <Plus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side={TIP_SIDE}>
              New tab
              <ShortcutKeys ids={["browser.newTab"]} />
            </TooltipContent>
          </Tooltip>
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
            {current?.loading ? (
              "Stop"
            ) : (
              <>
                Reload · ⇧ for hard reload
                <ShortcutKeys ids={["panel.refresh"]} />
              </>
            )}
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
        <DeviceMenu sessionId={sessionId} disabled={!current} />
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
  locked = false,
  onPick,
  onClose,
  onPointerDown,
  transform,
  held = false,
  gliding = false,
}: {
  active: boolean;
  title: string;
  icon: React.ReactNode;
  label: string;
  /// Neither picked nor closed, while a recording holds the strip.
  locked?: boolean;
  onPick: () => void;
  onClose: () => void;
  /// Drag-to-reorder, on real tabs only.
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  transform?: string;
  /// The tab in hand, mid-drag.
  held?: boolean;
  /// A tab sliding aside for the one in hand.
  gliding?: boolean;
}) {
  const pick = locked ? undefined : onPick;
  return (
    <div
      role="tab"
      aria-selected={active}
      aria-disabled={locked || undefined}
      tabIndex={locked ? -1 : 0}
      title={title}
      onClick={pick}
      onKeyDown={(e) => e.key === "Enter" && pick?.()}
      onPointerDown={onPointerDown}
      style={{ transform }}
      className={cn(
        "group/tab flex h-7 w-40 min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-t-md px-2 text-ui",
        active
          ? "browser-tab-active bg-card text-foreground"
          : locked
            ? "text-muted-foreground opacity-50"
            : held
              ? "bg-card/50 text-foreground"
              : "text-muted-foreground hover:bg-card/50 hover:text-foreground",
        // The one in hand tracks the pointer and draws over the tabs it
        // passes; only those making room glide.
        held && "relative z-10",
        gliding && "transition-transform duration-150 ease-out",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!locked && <button
        type="button"
        aria-label="Close tab"
        className="rounded p-0.5 opacity-0 hover:bg-muted group-hover/tab:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X className="size-3" />
      </button>}
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

/// Device size, picked where the button is: a native `<select>` laid over the
/// icon, so the menu is macOS's own. That is the point of it — an in-app menu
/// lands on the page, and the page is a native view nothing in the DOM draws
/// over, so opening one swapped the page for a picture of it (a flash) and a
/// pick made behind that picture came back with the view at a stale size.
/// A native menu is drawn above everything and touches neither.
///
/// Default clears everything and draws no bar; Responsive fills the pane the
/// same way but puts the bar up, so its size can be saved as a device.
function DeviceMenu({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const viewport = useViewport(sessionId);
  const responsive = useResponsive(sessionId);
  const saved = useCustomDevices();
  const apply = (next: Viewport | null) => setViewport(sessionId, next);
  const option = (d: Device) => (
    <option key={d.id} value={d.id}>
      {d.label}
    </option>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="group/device relative">
          <span
            aria-hidden
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon-sm" }),
              "group-hover/device:bg-foreground/10",
              (viewport || responsive) && "bg-foreground/10",
              disabled && "opacity-50",
            )}
          >
            <Smartphone className="size-3.5" />
          </span>
          <select
            aria-label="Device size"
            disabled={disabled}
            value={viewport?.preset ?? (responsive ? "responsive" : "default")}
            onChange={(e) => {
              if (e.target.value === "responsive") return setResponsive(sessionId);
              const d = [...VIEWPORT_PRESETS, ...saved].find((x) => x.id === e.target.value);
              apply(d ? { preset: d.id, width: d.width, height: d.height } : null);
            }}
            className="absolute inset-0 cursor-default appearance-none opacity-0"
          >
            <option value="default">Default</option>
            <option value="responsive">Responsive</option>
            {VIEWPORT_PRESETS.map(option)}
            {/* A disabled row rather than an <optgroup>, which macOS draws
                with its items indented off the rest of the list. */}
            {saved.length > 0 && (
              <option disabled value="">
                Saved
              </option>
            )}
            {saved.map(option)}
          </select>
        </div>
      </TooltipTrigger>
      <TooltipContent side={TIP_SIDE}>Device size</TooltipContent>
    </Tooltip>
  );
}

const BAR = "flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-card px-2 text-ui";

// Wide enough for four digits, with the native stepper off — it sat on the
// digits and stepped by one pixel.
const SIZE_INPUT =
  "h-6 w-16 rounded-md bg-surface-raised dark:bg-background px-2 font-mono text-ui tabular-nums outline-none focus:ring-1 focus:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

/// A typed size, clamped, or `fallback` where the field holds no number.
function clampSize(raw: string, fallback: number) {
  const n = Math.round(Number(raw));
  return n ? Math.max(200, Math.min(4000, n)) : fallback;
}

/// Responsive mode's bar: the page's size, editable, and Save to keep it as
/// a device under a name, or under the size itself. Untouched, the size is
/// the pane's own and follows it; typed into, the page lays out at that.
function SaveSizeBar({
  sessionId,
  size,
}: {
  sessionId: string;
  size: { width: number; height: number };
}) {
  const [width, setWidth] = useState(String(size.width));
  const [height, setHeight] = useState(String(size.height));
  const [name, setName] = useState("");
  // The pane resizing, or a typed size landing, moves the fields with it.
  useEffect(() => {
    setWidth(String(size.width));
    setHeight(String(size.height));
  }, [size.width, size.height]);

  const typed = () => ({
    width: clampSize(width, size.width),
    height: clampSize(height, size.height),
  });
  // On blur and Enter, not per keystroke: clamped per keystroke, the "1" of
  // "1200" became 200 before the rest could be typed.
  const commit = () => {
    const next = typed();
    setWidth(String(next.width));
    setHeight(String(next.height));
    if (next.width !== size.width || next.height !== size.height) {
      setViewport(sessionId, { preset: "responsive", ...next });
    }
  };
  const save = () => {
    const next = typed();
    const device = saveCustomDevice(name, next.width, next.height);
    setViewport(sessionId, { preset: device.id, ...next });
    setName("");
  };
  const onEnter = (action: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter") action();
  };

  return (
    <div className={BAR}>
      <input
        type="number"
        aria-label="Width"
        value={width}
        onChange={(e) => setWidth(e.target.value)}
        onBlur={commit}
        onKeyDown={onEnter(commit)}
        className={SIZE_INPUT}
      />
      <span className="text-muted-foreground">×</span>
      <input
        type="number"
        aria-label="Height"
        value={height}
        onChange={(e) => setHeight(e.target.value)}
        onBlur={commit}
        onKeyDown={onEnter(commit)}
        className={SIZE_INPUT}
      />
      <input
        aria-label="Name"
        value={name}
        placeholder="Name (optional)"
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onEnter(save)}
        className="h-6 w-32 min-w-0 rounded-md bg-surface-raised px-2 text-ui outline-none focus:ring-1 focus:ring-ring dark:bg-background"
      />
      <Button variant="ghost" size="sm" className={cn("h-6", TOOL_BTN)} onClick={save}>
        Save
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn("ml-auto", TOOL_BTN)}
            aria-label="Close"
            onClick={() => setViewport(sessionId, null)}
          >
            <X className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side={TIP_SIDE}>Close</TooltipContent>
      </Tooltip>
    </div>
  );
}

/// The device in use, under the toolbar for as long as one is: its name,
/// its size, rotate, and delete for a saved one.
function SizeBar({ sessionId, viewport }: { sessionId: string; viewport: Viewport }) {
  const saved = useCustomDevices();
  const own = saved.find((d) => d.id === viewport.preset);
  const device = VIEWPORT_PRESETS.find((d) => d.id === viewport.preset) ?? own;
  const [confirming, setConfirming] = useState(false);
  const apply = (next: Viewport | null) => setViewport(sessionId, next);

  if (confirming && own) {
    return (
      <div className={BAR}>
        <span className="min-w-0 truncate">Delete “{own.label}”?</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => {
            removeCustomDevice(own.id);
            apply(null);
          }}
        >
          Delete
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-6", TOOL_BTN)}
          autoFocus
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className={BAR}>
      {device && <span className="min-w-0 truncate">{device.label}</span>}
      <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
        {viewport.width} × {viewport.height}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={TOOL_BTN}
            aria-label="Rotate"
            onClick={() => apply({ ...viewport, width: viewport.height, height: viewport.width })}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side={TIP_SIDE}>Rotate</TooltipContent>
      </Tooltip>
      {own && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={TOOL_BTN}
              aria-label={`Delete ${own.label}`}
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={TIP_SIDE}>Delete this size</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn("ml-auto", TOOL_BTN)}
            aria-label="Close"
            onClick={() => apply(null)}
          >
            <X className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side={TIP_SIDE}>Close</TooltipContent>
      </Tooltip>
    </div>
  );
}

/// What to open when nothing is: this checkout's dev servers, the session's
/// own marked. Polled while on screen, since a server starting is the
/// moment the list is looked at.
function EmptyState({ sessionId, active }: { sessionId: string; active: boolean }) {
  const chromium = useChromium();
  // Nothing to open pages with yet: the download stands where the page would.
  if (chromium && chromium.state !== "ready") {
    return <ChromiumState status={chromium} />;
  }
  return <Servers sessionId={sessionId} active={active} />;
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

function Servers({ sessionId, active }: { sessionId: string; active: boolean }) {
  const [servers, setServers] = useState<LocalServer[]>([]);
  // Each read is a `ps` and two `lsof`s, and both mounts of this pane stay
  // mounted while hidden — so it reads only while on screen and frontmost,
  // and once more on coming back.
  const focused = useWindowFocused();
  const polling = active && focused;

  useEffect(() => {
    if (!polling) return;
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
  }, [sessionId, polling]);

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
