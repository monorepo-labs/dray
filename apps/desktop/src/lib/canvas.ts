import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";

/// One frame on the canvas: a route of the dev server, or one component
/// rendered alone through the Vite plugin's `/__dray/frame` harness. Height is
/// never stored; a frame is as tall as its page.
export type CanvasFrame = {
  id: string;
  name: string;
  route?: string;
  /// `file#export`, the file relative to the checkout.
  component?: string;
  props?: Record<string, unknown>;
  x: number;
  y: number;
  width: number;
};

export type CanvasPage = { id: string; name: string; frames: CanvasFrame[] };

/// `.dray/canvas.json`, written by this tab and by `dray canvas` alike. Fields
/// either side does not know are carried through untouched.
export type CanvasDoc = { version: 1; url?: string; pages: CanvasPage[]; [extra: string]: unknown };

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2, 8)}`;
}

/// Reads the file leniently: a frame missing its place gets one, a page with no
/// frames list gets an empty one, and no text at all is a canvas of one page.
export function parseCanvas(text: string | null): CanvasDoc {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const pages = (Array.isArray(raw.pages) ? raw.pages : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p, i) => ({
      ...p,
      id: typeof p.id === "string" ? p.id : `p-${i}`,
      name: typeof p.name === "string" ? p.name : `Page ${i + 1}`,
      frames: (Array.isArray(p.frames) ? p.frames : [])
        .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
        .map((f, j) => ({
          ...f,
          id: typeof f.id === "string" ? f.id : `f-${i}-${j}`,
          name: typeof f.name === "string" ? f.name : "Frame",
          x: num(f.x, j * 480),
          y: num(f.y, 0),
          width: num(f.width, typeof f.route === "string" ? 1280 : 400),
        })) as CanvasFrame[],
    }));
  return {
    ...raw,
    version: 1,
    pages: pages.length ? pages : [{ id: "p-1", name: "Page 1", frames: [] }],
  };
}

export function serializeCanvas(doc: CanvasDoc): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

const withPages = (doc: CanvasDoc, pages: CanvasPage[]): CanvasDoc => ({ ...doc, pages });

/// A page named one past the highest "Page N" already there.
export function addPage(doc: CanvasDoc, name?: string): { doc: CanvasDoc; id: string } {
  const taken = doc.pages.map((p) => /^Page (\d+)$/.exec(p.name)?.[1]).filter(Boolean).map(Number);
  const id = newId("p");
  const page = { id, name: name ?? `Page ${Math.max(doc.pages.length, ...taken) + 1}`, frames: [] };
  return { doc: withPages(doc, [...doc.pages, page]), id };
}

export function renamePage(doc: CanvasDoc, id: string, name: string): CanvasDoc {
  const trimmed = name.trim();
  if (!trimmed) return doc;
  return withPages(doc, doc.pages.map((p) => (p.id === id ? { ...p, name: trimmed } : p)));
}

export function movePage(doc: CanvasDoc, id: string, to: number): CanvasDoc {
  const from = doc.pages.findIndex((p) => p.id === id);
  if (from === -1) return doc;
  const pages = [...doc.pages];
  const [page] = pages.splice(from, 1);
  pages.splice(Math.max(0, Math.min(to, pages.length)), 0, page);
  return withPages(doc, pages);
}

/// Deleting a page takes only its frames off the canvas; their code stays.
/// The last page cannot go.
export function deletePage(doc: CanvasDoc, id: string): CanvasDoc {
  if (doc.pages.length < 2) return doc;
  return withPages(doc, doc.pages.filter((p) => p.id !== id));
}

export function updateFrame(doc: CanvasDoc, id: string, patch: Partial<CanvasFrame>): CanvasDoc {
  return withPages(
    doc,
    doc.pages.map((p) =>
      p.frames.some((f) => f.id === id) ? { ...p, frames: p.frames.map((f) => (f.id === id ? { ...f, ...patch } : f)) } : p,
    ),
  );
}

/// Moves a frame to another page, placed after that page's rightmost frame.
export function moveFrameToPage(doc: CanvasDoc, frameId: string, pageId: string): CanvasDoc {
  const frame = doc.pages.flatMap((p) => p.frames).find((f) => f.id === frameId);
  const target = doc.pages.find((p) => p.id === pageId);
  if (!frame || !target || target.frames.some((f) => f.id === frameId)) return doc;
  const placed = { ...frame, ...placeAfter(target.frames) };
  return withPages(
    doc,
    doc.pages.map((p) =>
      p.id === pageId ? { ...p, frames: [...p.frames, placed] } : { ...p, frames: p.frames.filter((f) => f.id !== frameId) },
    ),
  );
}

/// Takes a frame off the canvas. Never touches its code.
export function removeFrame(doc: CanvasDoc, frameId: string): CanvasDoc {
  return withPages(doc, doc.pages.map((p) => ({ ...p, frames: p.frames.filter((f) => f.id !== frameId) })));
}

export function addFrame(doc: CanvasDoc, pageId: string, frame: Omit<CanvasFrame, "x" | "y" | "id">): CanvasDoc {
  return withPages(
    doc,
    doc.pages.map((p) =>
      p.id === pageId ? { ...p, frames: [...p.frames, { ...frame, id: newId("f"), ...placeAfter(p.frames) }] } : p,
    ),
  );
}

const GAP = 80;

function placeAfter(frames: CanvasFrame[]): { x: number; y: number } {
  if (!frames.length) return { x: 0, y: 0 };
  return {
    x: Math.max(...frames.map((f) => f.x + f.width)) + GAP,
    y: Math.min(...frames.map((f) => f.y)),
  };
}

/// Where a frame loads from, on the dev server at `base`.
export function frameUrl(base: string, frame: CanvasFrame): string {
  const root = base.replace(/\/+$/, "");
  if (frame.component) {
    const [file, name = "default"] = frame.component.split("#");
    const q = new URLSearchParams({ c: file.replace(/^\.?\//, ""), e: name });
    if (frame.props && Object.keys(frame.props).length) q.set("p", JSON.stringify(frame.props));
    return `${root}/__dray/frame?${q}`;
  }
  const route = frame.route ?? "/";
  return root + (route.startsWith("/") ? route : `/${route}`);
}

/// What the Vite plugin's inspector says about an element picked in a frame.
export type PickedElement = {
  tag: string;
  id: string | null;
  classes: string;
  text: string;
  /// `file:line:col`, relative to the checkout; the nearest stamped ancestor's
  /// where the element itself carries none (`sourceIsOwn` false).
  source: string | null;
  sourceIsOwn: boolean;
  components: string[];
  rect: { x: number; y: number; width: number; height: number };
  styles: {
    display: string;
    flexDirection: string | null;
    gap: string | null;
    padding: string[];
    margin: string[];
    borderWidth: string[];
    borderStyle: string;
    borderColor: string;
    borderRadius: string[];
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    letterSpacing: string;
    textAlign: string;
    color: string;
    background: string;
    opacity: string;
    boxShadow: string;
  };
};

/// A pick as the composer holds it, keyed so picking the same element twice
/// pins one chip.
export type CanvasPick = { key: string; frame: string; page: string; element: PickedElement };

/// `1px 2px 1px 2px` → `1px 2px`, the CSS shorthand a reader expects.
export function sides(v: string[]): string {
  const [t, r, b, l] = v;
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return v.join(" ");
}

const transparent = (c: string) => c === "transparent" || c === "rgba(0, 0, 0, 0)";

/// The chip's label: the element and where it lives.
export function pickLabel(el: PickedElement): string {
  const where = el.source ? el.source.split(":").slice(0, 2).join(":").split("/").pop() : null;
  const comp = el.components.at(-1);
  return [`<${el.tag}>`, comp, where].filter(Boolean).join(" · ");
}

/// The block a pick adds to the prompt: enough for the agent to find the
/// element and see what it looks like without a screenshot.
export function describeCanvasPick(pick: CanvasPick): string {
  const el = pick.element;
  const s = el.styles;
  const lines = [`Canvas element: <${el.tag}> in frame "${pick.frame}" (page "${pick.page}")`];
  if (el.source) lines.push(`- Source: ${el.source}${el.sourceIsOwn ? "" : " (nearest stamped parent)"}`);
  if (el.components.length) lines.push(`- Components: ${el.components.join(" > ")}`);
  if (el.text) lines.push(`- Text: "${el.text}"`);
  if (el.classes) lines.push(`- Classes: ${el.classes}`);
  lines.push(`- Size: ${el.rect.width}×${el.rect.height}, display ${s.display}${s.gap && s.gap !== "normal" ? `, gap ${s.gap}` : ""}`);
  lines.push(`- Padding ${sides(s.padding)}; margin ${sides(s.margin)}`);
  const border = sides(s.borderWidth);
  lines.push(
    `- Border ${border === "0px" ? "none" : `${border} ${s.borderStyle} ${s.borderColor}`}; radius ${sides(s.borderRadius)}`,
  );
  lines.push(`- Font ${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily.split(",")[0]}, colour ${s.color}`);
  if (!transparent(s.background)) lines.push(`- Background ${s.background}`);
  return lines.join("\n");
}

// The composer's canvas chips, per session, the way `useAttachments` holds
// files: module-level, since the canvas and the composer are far apart in the tree.
const picks = new Map<string, CanvasPick[]>();
const picksChanged = channel<void>();
const EMPTY: CanvasPick[] = [];

/// Pins a pick to the session's composer. `add` keeps the ones already there;
/// otherwise the new pick replaces the last canvas chip, so clicking around to
/// inspect leaves one chip rather than a pile.
export function pinCanvasPick(sessionId: string, pick: CanvasPick, add: boolean) {
  const current = picks.get(sessionId) ?? EMPTY;
  const kept = current.filter((p) => p.key !== pick.key);
  const next = add ? [...kept, pick] : [...kept.slice(0, -1), pick];
  picks.set(sessionId, next);
  picksChanged.emit();
}

export function unpinCanvasPick(sessionId: string, key: string) {
  const current = picks.get(sessionId);
  if (!current) return;
  const next = current.filter((p) => p.key !== key);
  if (next.length) picks.set(sessionId, next);
  else picks.delete(sessionId);
  picksChanged.emit();
}

export function clearCanvasPicks(sessionId: string) {
  if (picks.delete(sessionId)) picksChanged.emit();
}

export function readCanvasPicks(sessionId: string | null): CanvasPick[] {
  return (sessionId && picks.get(sessionId)) || EMPTY;
}

export function useCanvasPicks(sessionId: string | null): CanvasPick[] {
  return useSyncExternalStore(picksChanged.subscribe, () => readCanvasPicks(sessionId));
}

/// The text a send carries: the reader's own words, then one block per pick.
export function withCanvasPicks(text: string, chips: CanvasPick[]): string {
  if (!chips.length) return text;
  const blocks = chips.map(describeCanvasPick).join("\n\n");
  return text ? `${text}\n\n${blocks}` : blocks;
}
