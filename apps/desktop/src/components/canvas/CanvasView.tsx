import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Component, Maximize, Minus, MousePointer2, Plus, Pointer, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import StylePanel from "@/components/canvas/StylePanel";
import { appendToDraft } from "@/hooks/useDraft";
import { useDragReorder } from "@/hooks/useDragReorder";
import { listLocalServers, reachableUrl } from "@/lib/browser";
import {
  addFrame,
  addPage,
  deletePage,
  frameUrl,
  moveFrameToPage,
  movePage,
  parseCanvas,
  pinCanvasPick,
  removeFrame,
  renamePage,
  serializeCanvas,
  updateFrame,
  type CanvasDoc,
  type CanvasFrame,
  type PickedElement,
} from "@/lib/canvas";
import { invoke, serverOfSession } from "@/lib/transport";
import { cn } from "@/lib/utils";

type Camera = { x: number; y: number; z: number };
type Tool = "select" | "interact";
type Selection = { frame: string; element: PickedElement };

const POLL = 1500;
const SERVER_POLL = 4000;
const MIN_Z = 0.05;
const MAX_Z = 4;
/// Height a frame takes before its page has said how tall it is.
const DEFAULT_H = 720;
/// A page taller than this is cut off rather than drawn whole.
const MAX_H = 6000;

// Each page's camera, per session, so leaving the tab and coming back finds
// the view where it was. In memory, like the tab row's own state.
const cameras = new Map<string, Camera>();
/// The page each task was last on, kept the same way.
const lastPage = new Map<string, string>();

const clampZ = (z: number) => Math.min(MAX_Z, Math.max(MIN_Z, z));

/// The task's design canvas (#1685): pages of live frames from the project's
/// own dev server, `.dray/canvas.json` holding what is where.
export default function CanvasView({ sessionId, cwd, active }: { sessionId: string; cwd: string; active: boolean }) {
  const server = serverOfSession(sessionId);
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageId, setPageIdState] = useState<string | null>(() => lastPage.get(sessionId) ?? null);
  const setPageId = useCallback(
    (id: string) => {
      lastPage.set(sessionId, id);
      setPageIdState(id);
    },
    [sessionId],
  );
  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  // A component wider than its frame widens it, rather than scroll inside it.
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [base, setBase] = useState<string | null>(null);
  const [serverChecked, setServerChecked] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [silent, setSilent] = useState<Set<string>>(new Set());
  const lastText = useRef<string | null | undefined>(undefined);
  const knownFrames = useRef<Set<string> | null>(null);
  const holding = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const page = doc?.pages.find((p) => p.id === pageId) ?? doc?.pages[0] ?? null;

  // ── load and save ────────────────────────────────────────────────────────
  const fitRequest = useRef<string | null>(null);
  const load = useCallback(async () => {
    let text: string | null;
    try {
      text = await invoke<string | null>("canvas_load", { cwd }, server);
      setError(null);
    } catch (e) {
      setError(String(e));
      return;
    }
    if (text === lastText.current || holding.current) return;
    lastText.current = text;
    const next = parseCanvas(text);
    // A frame the agent added brings its page up, fitted, so asking for
    // designs shows them without hunting for where they went.
    const ids = new Set(next.pages.flatMap((p) => p.frames.map((f) => f.id)));
    const known = knownFrames.current;
    if (known) {
      const fresh = next.pages.find((p) => p.frames.some((f) => !known.has(f.id)));
      if (fresh) {
        setPageId(fresh.id);
        fitRequest.current = fresh.id;
      }
    }
    knownFrames.current = ids;
    setDoc(next);
  }, [cwd, server, setPageId]);

  const save = useCallback(
    (next: CanvasDoc) => {
      setDoc(next);
      knownFrames.current = new Set(next.pages.flatMap((p) => p.frames.map((f) => f.id)));
      const text = serializeCanvas(next);
      lastText.current = text;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        invoke("canvas_save", { cwd, text }, server).catch((e) => setError(String(e)));
      }, 200);
    },
    [cwd, server],
  );

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => void load(), POLL);
    return () => clearInterval(timer);
  }, [active, load]);

  // ── the dev server ───────────────────────────────────────────────────────
  const pinnedUrl = typeof doc?.url === "string" ? doc.url : null;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const find = async () => {
      let url = pinnedUrl;
      if (!url) {
        const servers = await listLocalServers(sessionId).catch(() => []);
        const mine = servers.filter((s) => s.mine).sort((a, b) => a.port - b.port);
        const pick = mine.find((s) => /node|vite|bun|deno/i.test(s.process)) ?? mine[0];
        url = pick ? `http://localhost:${pick.port}` : null;
      }
      const reach = url ? await reachableUrl(sessionId, url).catch(() => url) : null;
      if (cancelled) return;
      setBase((prev) => (prev === reach ? prev : reach));
      setServerChecked(true);
    };
    void find();
    const timer = setInterval(() => void find(), SERVER_POLL);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, sessionId, pinnedUrl]);

  // ── the camera ───────────────────────────────────────────────────────────
  const viewport = useRef<HTMLDivElement>(null);
  const camKey = `${sessionId}:${page?.id ?? ""}`;
  const [cam, setCamState] = useState<Camera>(() => cameras.get(camKey) ?? { x: 80, y: 80, z: 0.5 });
  const camRef = useRef(cam);
  const setCam = useCallback(
    (next: Camera) => {
      camRef.current = next;
      cameras.set(camKey, next);
      setCamState(next);
    },
    [camKey],
  );
  useLayoutEffect(() => {
    const saved = cameras.get(camKey);
    if (saved) {
      camRef.current = saved;
      setCamState(saved);
    } else fitRequest.current = page?.id ?? null;
  }, [camKey, page?.id]);

  const heightOf = useCallback((f: CanvasFrame) => heights[f.id] ?? DEFAULT_H, [heights]);
  const widthOf = useCallback((f: CanvasFrame) => Math.max(f.width, widths[f.id] ?? 0), [widths]);

  const fit = useCallback(
    (frames: CanvasFrame[]) => {
      const el = viewport.current;
      if (!el || !frames.length) return;
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      const x0 = Math.min(...frames.map((f) => f.x));
      const y0 = Math.min(...frames.map((f) => f.y));
      const x1 = Math.max(...frames.map((f) => f.x + widthOf(f)));
      const y1 = Math.max(...frames.map((f) => f.y + heightOf(f)));
      const pad = 72;
      const z = clampZ(Math.min(1, (width - pad * 2) / (x1 - x0), (height - pad * 2) / (y1 - y0)));
      setCam({ z, x: (width - (x1 - x0) * z) / 2 - x0 * z, y: Math.max(pad, (height - (y1 - y0) * z) / 2) - y0 * z });
    },
    [heightOf, widthOf, setCam],
  );

  // A fit asked for before the frames had a size waits for the layout.
  useEffect(() => {
    if (!active || !page || fitRequest.current !== page.id || !page.frames.length) return;
    fitRequest.current = null;
    fit(page.frames);
  }, [active, page, fit]);

  const zoomAt = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      const el = viewport.current;
      if (!el) return;
      const c = camRef.current;
      const r = el.getBoundingClientRect();
      const px = at ? at.x - r.left : r.width / 2;
      const py = at ? at.y - r.top : r.height / 2;
      const z = clampZ(c.z * factor);
      setCam({ z, x: px - ((px - c.x) * z) / c.z, y: py - ((py - c.y) * z) / c.z });
    },
    [setCam],
  );

  // Native, since React's wheel listener is passive and cannot stop the page
  // scrolling. A pinch arrives as a wheel with ctrlKey held.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), { x: e.clientX, y: e.clientY });
      } else {
        const c = camRef.current;
        const k = e.deltaMode === 1 ? 16 : 1;
        setCam({ ...c, x: c.x - (e.shiftKey ? e.deltaY : e.deltaX) * k, y: c.y - (e.shiftKey ? 0 : e.deltaY) * k });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, setCam, doc !== null]);

  // Space held pans from anywhere, as every design tool does.
  const [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    if (!active) return;
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space") {
        e.preventDefault();
        setSpaceHeld(true);
      } else if (e.key === "v" || e.key === "V") setTool("select");
      else if (e.key === "i" || e.key === "I") setTool("interact");
      else if (e.key === "Escape") setSelection(null);
      else if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) page && fit(page.frames);
      else if (e.key === "=" || e.key === "+") zoomAt(1.25);
      else if (e.key === "-") zoomAt(0.8);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [active, page, fit, zoomAt]);

  const [panning, setPanning] = useState(false);
  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, cam: camRef.current };
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    setPanning(true);
    const move = (ev: PointerEvent) =>
      setCam({ ...start.cam, x: start.cam.x + ev.clientX - start.x, y: start.cam.y + ev.clientY - start.y });
    const end = () => {
      setPanning(false);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };

  // ── frames talking back ──────────────────────────────────────────────────
  const iframes = useRef(new Map<string, HTMLIFrameElement>());
  const post = (frameId: string, msg: Record<string, unknown>) =>
    iframes.current.get(frameId)?.contentWindow?.postMessage({ dray: true, ...msg }, "*");
  const heard = useRef(new Set<string>());

  const frameName = useCallback(
    (id: string) => {
      for (const p of doc?.pages ?? []) {
        const f = p.frames.find((x) => x.id === id);
        if (f) return { frame: f.name, page: p.name };
      }
      return { frame: id, page: "" };
    },
    [doc],
  );
  const frameNameRef = useRef(frameName);
  frameNameRef.current = frameName;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data;
      if (!m || m.dray !== true || typeof m.type !== "string") return;
      let id: string | null = null;
      for (const [key, el] of iframes.current) if (el.contentWindow === e.source) id = key;
      if (!id) return;
      if (!heard.current.has(id)) {
        heard.current.add(id);
        setSilent((s) => {
          if (!s.has(id!)) return s;
          const next = new Set(s);
          next.delete(id!);
          return next;
        });
      }
      if (m.type === "ready" && m.frame !== id) post(id, { type: "hello", frame: id });
      else if (m.type === "size" && typeof m.height === "number") {
        const h = Math.max(40, Math.min(MAX_H, Math.ceil(m.height)));
        setHeights((prev) => (prev[id!] === h ? prev : { ...prev, [id!]: h }));
        if (typeof m.width === "number") {
          const w = Math.min(4000, Math.ceil(m.width));
          setWidths((prev) => (prev[id!] === w ? prev : { ...prev, [id!]: w }));
        }
      } else if (m.type === "picked") {
        if (!m.element) return setSelection(null);
        const element = m.element as PickedElement;
        setSelection({ frame: id, element });
        if (m.refreshed) return;
        const names = frameNameRef.current(id);
        pinCanvasPick(
          sessionId,
          { key: `${id}:${element.source}:${element.rect.x},${element.rect.y}`, ...names, element },
          !!m.add,
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sessionId]);

  // A pick belongs to its page: another page's styles would describe nothing on screen.
  const pageKey = page?.id;
  useEffect(() => setSelection(null), [pageKey]);

  // Clear outlines left in other frames when the selection moves on.
  useEffect(() => {
    for (const id of iframes.current.keys()) if (id !== selection?.frame) post(id, { type: "clear" });
  }, [selection?.frame]);

  const onFrameLoad = (id: string) => {
    post(id, { type: "hello", frame: id });
    // A page with no inspector never answers; say so rather than draw a frame
    // that silently ignores clicks.
    setTimeout(() => {
      if (!heard.current.has(id)) setSilent((s) => new Set(s).add(id));
    }, 4000);
  };

  // ── editing ──────────────────────────────────────────────────────────────
  const moveFrame = (e: React.PointerEvent, frame: CanvasFrame) => {
    if (e.button !== 0 || !doc) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, fx: frame.x, fy: frame.y };
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    holding.current = true;
    let latest = doc;
    const move = (ev: PointerEvent) => {
      const z = camRef.current.z;
      latest = updateFrame(doc, frame.id, {
        x: Math.round(start.fx + (ev.clientX - start.x) / z),
        y: Math.round(start.fy + (ev.clientY - start.y) / z),
      });
      setDoc(latest);
    };
    const end = () => {
      holding.current = false;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      if (latest !== doc) save(latest);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
  };

  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState("");

  const addFromInput = () => {
    if (!doc || !page) return;
    const spec = adding.trim();
    if (!spec) return;
    const component = /#|\.(t|j)sx?$/.test(spec) && !spec.startsWith("/");
    const frame = component
      ? (() => {
          const [file, name = "default"] = spec.split("#");
          return { name: name === "default" ? (file.split("/").pop() ?? file) : name, component: `${file}#${name}`, width: 400 };
        })()
      : { name: spec.startsWith("/") ? spec : `/${spec}`, route: spec.startsWith("/") ? spec : `/${spec}`, width: 1280 };
    fitRequest.current = page.id;
    save(addFrame(doc, page.id, frame));
    setAdding("");
  };

  const pagesDrag = useDragReorder(
    doc?.pages ?? [],
    (p) => p.id,
    (p, _d, to) => {
      if (doc) save(movePage(doc, p.id, to));
    },
    "y",
  );

  const frames = page?.frames ?? [];
  const selectedFrame = selection ? frames.find((f) => f.id === selection.frame) : undefined;
  const silentShown = frames.some((f) => silent.has(f.id));

  const urls = useMemo(
    () => (base ? Object.fromEntries(frames.map((f) => [f.id, frameUrl(base, f)])) : {}),
    [base, frames],
  );

  if (!doc) {
    return (
      <div className="flex flex-1 items-center justify-center text-ui text-muted-foreground">
        {error ?? "Loading the canvas…"}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 select-none">
      {/* Pages and layers, Figma's left column. */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-border/60">
        <div className="flex h-9 shrink-0 items-center justify-between pr-1.5 pl-3">
          <span className="text-ui font-medium">Pages</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Add a page"
                className="text-muted-foreground"
                onClick={() => {
                  const { doc: next, id } = addPage(doc);
                  save(next);
                  setPageId(id);
                  setRenaming(id);
                }}
              >
                <Plus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Add a page</TooltipContent>
          </Tooltip>
        </div>
        <div ref={pagesDrag.list} className="flex shrink-0 flex-col gap-px px-1.5 pb-2">
          {pagesDrag.shown.map((p, i) => (
            <ContextMenu key={p.id}>
              <ContextMenuTrigger asChild>
                <div
                  role="button"
                  tabIndex={0}
                  onPointerDown={(e) => renaming !== p.id && pagesDrag.start(e, i)}
                  onClick={() => setPageId(p.id)}
                  onDoubleClick={() => setRenaming(p.id)}
                  style={{ transform: pagesDrag.offset(i) }}
                  className={cn(
                    "flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-ui",
                    p.id === page?.id ? "bg-foreground/[0.07] font-medium" : "text-muted-foreground hover:bg-foreground/[0.04]",
                    pagesDrag.drag?.from === i && "relative z-10 bg-background shadow-sm",
                    !pagesDrag.drag && "transition-transform",
                  )}
                >
                  {renaming === p.id ? (
                    <RenameInput
                      value={p.name}
                      onDone={(name) => {
                        if (name !== null) save(renamePage(doc, p.id, name));
                        setRenaming(null);
                      }}
                    />
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="text-xs text-muted-foreground/70 tabular-nums">{p.frames.length || ""}</span>
                    </>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => setRenaming(p.id)}>Rename</ContextMenuItem>
                <ContextMenuItem onSelect={() => save(movePage(doc, p.id, i - 1))} disabled={i === 0}>
                  Move up
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => save(movePage(doc, p.id, i + 1))}
                  disabled={i === doc.pages.length - 1}
                >
                  Move down
                </ContextMenuItem>
                <ContextMenuItem disabled={doc.pages.length < 2} onSelect={() => save(deletePage(doc, p.id))}>
                  Remove page{p.frames.length ? " and its frames" : ""}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>

        <div className="mx-3 border-t border-border/60" />
        <div className="flex h-9 shrink-0 items-center px-3 text-ui font-medium">Frames</div>
        <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5">
          {frames.length === 0 && <p className="px-2 text-ui text-muted-foreground">None on this page.</p>}
          {frames.map((f) => (
            <ContextMenu key={f.id}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  onClick={() => fit([f])}
                  onDoubleClick={() => setRenaming(f.id)}
                  className={cn(
                    "flex h-7 items-center gap-2 rounded-md px-2 text-left text-ui hover:bg-foreground/[0.04]",
                    selection?.frame === f.id && "bg-foreground/[0.07]",
                  )}
                >
                  {f.component ? (
                    <Component className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <AppWindow className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  {renaming === f.id ? (
                    <RenameInput
                      value={f.name}
                      onDone={(name) => {
                        if (name?.trim()) save(updateFrame(doc, f.id, { name: name.trim() }));
                        setRenaming(null);
                      }}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  )}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => fit([f])}>Zoom to frame</ContextMenuItem>
                <ContextMenuItem onSelect={() => setRenaming(f.id)}>Rename</ContextMenuItem>
                <ContextMenuSub>
                  <ContextMenuSubTrigger disabled={doc.pages.length < 2}>Move to page</ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    {doc.pages
                      .filter((p) => p.id !== page?.id)
                      .map((p) => (
                        <ContextMenuItem key={p.id} onSelect={() => save(moveFrameToPage(doc, f.id, p.id))}>
                          {p.name}
                        </ContextMenuItem>
                      ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuItem onSelect={() => save(removeFrame(doc, f.id))}>Take off the canvas</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
        <form
          className="shrink-0 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            addFromInput();
          }}
        >
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="Add /route or src/X.tsx#X"
            aria-label="Add a frame: a route like /pricing, or a component like src/Card.tsx#Card"
            className="h-7 w-full rounded-md border border-border/70 bg-transparent px-2 text-ui outline-none placeholder:text-muted-foreground/70 focus:border-ring"
          />
        </form>
      </aside>

      {/* The surface. */}
      <div
        ref={viewport}
        className={cn(
          "relative min-w-0 flex-1 overflow-hidden bg-foreground/[0.035]",
          (spaceHeld || panning) && "cursor-grab",
          panning && "cursor-grabbing",
        )}
        style={{
          backgroundImage: "radial-gradient(color-mix(in oklab, var(--foreground) 14%, transparent) 1px, transparent 1px)",
          backgroundSize: `${24 * cam.z}px ${24 * cam.z}px`,
          backgroundPosition: `${cam.x}px ${cam.y}px`,
        }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || spaceHeld || e.button === 1) {
            if (e.target === e.currentTarget && !spaceHeld) setSelection(null);
            startPan(e);
          }
        }}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})` }}
        >
          {base &&
            frames.map((f) => (
              <div key={f.id} className="absolute" style={{ left: f.x, top: f.y, width: widthOf(f) }}>
                {/* The label stays one size on screen whatever the zoom. */}
                <div
                  className="absolute bottom-full left-0 flex origin-bottom-left cursor-move items-center gap-1.5 pb-1 text-[12px] whitespace-nowrap text-muted-foreground hover:text-foreground"
                  style={{ transform: `scale(${1 / cam.z})` }}
                  onPointerDown={(e) => (spaceHeld ? startPan(e) : moveFrame(e, f))}
                  onDoubleClick={() => setRenaming(f.id)}
                >
                  {f.component ? <Component className="size-3" /> : <AppWindow className="size-3" />}
                  <span className={cn(selection?.frame === f.id && "text-[#0d99ff]")}>{f.name}</span>
                  {silent.has(f.id) && <span className="text-amber-600">· no inspector</span>}
                </div>
                <div
                  className={cn(
                    "relative overflow-hidden bg-white shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.06)]",
                    selection?.frame === f.id && "shadow-[0_0_0_1.5px_#0d99ff]",
                  )}
                  style={{ height: heightOf(f) }}
                >
                  <iframe
                    key={`${f.id}:${reloadKey}`}
                    ref={(el) => {
                      if (el) iframes.current.set(f.id, el);
                      else iframes.current.delete(f.id);
                    }}
                    src={urls[f.id]}
                    title={f.name}
                    onLoad={() => onFrameLoad(f.id)}
                    className="block border-0"
                    style={{ width: widthOf(f), height: heightOf(f), pointerEvents: tool === "interact" && !spaceHeld ? "auto" : "none" }}
                  />
                  {(tool === "select" || spaceHeld) && (
                    // Over the page, so the canvas keeps every wheel and drag
                    // and a click is a pick, sent in as the page's own coordinates.
                    <div
                      className={cn("absolute inset-0", spaceHeld ? "cursor-grab" : "cursor-default")}
                      onPointerDown={(e) => {
                        if (spaceHeld || e.button === 1) return startPan(e);
                      }}
                      onPointerMove={(e) => {
                        if (spaceHeld || panning) return;
                        const r = e.currentTarget.getBoundingClientRect();
                        const z = camRef.current.z;
                        post(f.id, { type: "hover", x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z });
                      }}
                      onPointerLeave={() => post(f.id, { type: "leave" })}
                      onClick={(e) => {
                        if (spaceHeld) return;
                        const r = e.currentTarget.getBoundingClientRect();
                        const z = camRef.current.z;
                        post(f.id, {
                          type: "pick",
                          x: (e.clientX - r.left) / z,
                          y: (e.clientY - r.top) / z,
                          add: e.shiftKey,
                        });
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
        </div>

        {/* Tools, floating at the top. */}
        <div className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-border/70 bg-popover p-0.5 shadow-sm">
          <ToolButton label="Inspect" keys="V" on={tool === "select"} onClick={() => setTool("select")}>
            <MousePointer2 className="size-3.5" />
          </ToolButton>
          <ToolButton label="Use the page" keys="I" on={tool === "interact"} onClick={() => setTool("interact")}>
            <Pointer className="size-3.5" />
          </ToolButton>
          <div className="mx-1 h-4 w-px bg-border" />
          <ToolButton label="Zoom out" keys="−" onClick={() => zoomAt(0.8)}>
            <Minus className="size-3.5" />
          </ToolButton>
          <button
            type="button"
            onClick={() => zoomAt(1 / camRef.current.z)}
            className="h-7 w-12 rounded-md text-center text-ui text-muted-foreground tabular-nums hover:bg-foreground/5 hover:text-foreground"
            aria-label="Zoom to 100%"
          >
            {Math.round(cam.z * 100)}%
          </button>
          <ToolButton label="Zoom in" keys="+" onClick={() => zoomAt(1.25)}>
            <Plus className="size-3.5" />
          </ToolButton>
          <ToolButton label="Fit the page" keys="⇧1" onClick={() => page && fit(page.frames)}>
            <Maximize className="size-3.5" />
          </ToolButton>
          <div className="mx-1 h-4 w-px bg-border" />
          <ToolButton label="Reload frames" onClick={() => setReloadKey((k) => k + 1)}>
            <RefreshCw className="size-3.5" />
          </ToolButton>
          <span className="flex items-center gap-1.5 px-2 text-ui text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", base ? "bg-emerald-500" : "bg-muted-foreground/40")} />
            {base ? new URL(base).host : "No dev server"}
          </span>
        </div>

        {!base && serverChecked && (
          <Empty
            title="No dev server for this task"
            body="Frames are live pages from the project's dev server. Start it from the task's checkout, or ask the agent."
            action={{
              label: "Ask the agent to start it",
              run: () =>
                appendToDraft(
                  sessionId,
                  "Start this project's dev server in the background for the canvas, and run `dray canvas setup` if it is not set up yet.",
                ),
            }}
          />
        )}
        {base && frames.length === 0 && (
          <Empty
            title="Nothing on this page yet"
            body={`Ask the agent for designs, like "3 variations of the hero on a page called Explorations", or add a route or a component at the bottom left.`}
          />
        )}
        {silentShown && (
          <div className="absolute bottom-3 left-1/2 max-w-md -translate-x-1/2 rounded-lg border border-border/70 bg-popover px-3 py-2 text-ui text-muted-foreground shadow-sm">
            Some frames can't be inspected: the project's dev server isn't running Dray's Vite plugin. Run{" "}
            <code className="text-foreground">dray canvas setup</code> in the task, or ask the agent to.
          </div>
        )}
        {error && (
          <div className="absolute right-3 bottom-3 rounded-lg bg-destructive/10 px-3 py-2 text-ui text-destructive">{error}</div>
        )}
      </div>

      <StylePanel selection={selection?.element ?? null} frame={selectedFrame?.name ?? null} />
    </div>
  );
}

function ToolButton({
  label,
  keys,
  on,
  onClick,
  children,
}: {
  label: string;
  keys?: string;
  on?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={on}
          onClick={onClick}
          className={cn("text-muted-foreground", on && "bg-foreground/[0.08] text-foreground")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {keys && <span className="ml-2 text-muted-foreground">{keys}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  const [text, setText] = useState(value);
  return (
    <input
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(text)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(text);
        else if (e.key === "Escape") onDone(null);
      }}
      className="h-5 min-w-0 flex-1 rounded-sm bg-background px-1 text-ui outline-none ring-1 ring-ring"
    />
  );
}

function Empty({ title, body, action }: { title: string; body: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
      <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-2 text-center">
        <p className="text-ui font-medium">{title}</p>
        <p className="text-ui text-muted-foreground">{body}</p>
        {action && (
          <Button variant="outline" size="sm" className="mt-1" onClick={action.run}>
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}
