import { useEffect, useSyncExternalStore } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { isMarkdownPath } from "@/lib/markdown";
import { openFile } from "@/lib/openWith";
import type { SaveOutcome } from "@/types/events";

/// Whether the reader is reading the file or writing it. Per doc, not one
/// setting for the panel: a reader flipping one file into edit mode has said
/// nothing about the next one they open.
export type DocMode = "view" | "edit";

/// A tagged union over the read's lifecycle, so there is no state in which a
/// draft exists without the text it was made from. A `text` field plus a
/// `loaded` boolean is the same data with one extra way to be wrong.
export type DocBody =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      /// The text this draft was made from, and what the next save compares
      /// against.
      base: string;
      draft: string;
      /// The file changed on disk under a dirty draft. A clean doc adopts the
      /// new text instead, so this is only ever set where something would be
      /// lost either way.
      stale: boolean;
      saving: boolean;
      /// Why the last write failed, where it failed for a reason other than
      /// staleness — and a re-read the reader *asked* for, which fails the same
      /// way and has the same one line of the stale strip to say so in.
      saveError: string | null;
    };

export type Doc = { path: string; mode: DocMode; body: DocBody };

/// A ready body, named so the rules below can take one without restating the
/// union member.
type Ready = Extract<DocBody, { status: "ready" }>;

/// Whether the draft has moved off what was read.
///
/// Derived on every read rather than stored beside the text, because a stored
/// flag is what lets the two disagree — an edit that forgets to set it leaves a
/// changed file the panel calls clean, and a save that forgets to clear it
/// leaves a saved one it calls dirty.
export function isDirty(doc: Doc): boolean {
  return doc.body.status === "ready" && doc.body.draft !== doc.body.base;
}

/// What a doc becomes when the file underneath it is read again.
///
/// A clean doc takes the new text outright: nothing is lost, and the reader is
/// looking at what the file says rather than at what it said. A dirty one keeps
/// its draft and is flagged instead — the two versions are both wanted, and
/// only the reader can say which. Disk text equal to `base` is no news at all,
/// so it leaves the doc exactly as it was.
///
/// `base` deliberately stays put on the stale branch. It is what the next save
/// sends as `expect`, and moving it to the disk text would turn the backend's
/// compare-and-swap into a silent overwrite of the write that caused this.
export function withDiskText(body: Ready, disk: string): Ready {
  if (disk === body.base) return body;
  if (body.draft === body.base) {
    return { ...body, base: disk, draft: disk, stale: false };
  }
  return { ...body, stale: true };
}

/// Open docs, per session, in the order they were opened.
///
/// Keyed by session because a doc is opened from a transcript, and a transcript
/// belongs to one session — a chip strip held for the whole app put a file
/// opened in one session on screen in every other one, with nothing but its
/// path to say where it came from. The panel hides rather than unmounts either
/// way, so a session's own docs still survive being switched away from and
/// back.
///
/// Two sessions can therefore hold their own draft of one file. That is not a
/// silent race: `saveDoc` sends the text its draft was made from as `expect`
/// and the backend re-reads before writing, so the second save answers `stale`
/// and draws the strip rather than overwriting the first.
const bySession = new Map<string, SessionDocs>();

type SessionDocs = {
  docs: Doc[];
  activePath: string | null;
  /// The doc whose save met a file that had moved, or `null`. Held here rather
  /// than in the panel because ⌘S and the Save button are two routes into one
  /// save, and a dialog owned by the button cannot be raised by the chord.
  clash: string | null;
};

/// Shared by every session that has opened nothing, so an untouched session
/// costs no entry and the snapshot keeps one identity across its renders.
const EMPTY: SessionDocs = { docs: [], activePath: null, clash: null };

/// Whose docs the panel is showing, written by `App` from its selection. A
/// module variable rather than an argument on all nine exports: every caller is
/// already the selected session — the transcript that opens a doc and the panel
/// that edits one are both drawn for it — so an argument would be the same
/// value threaded through the tree to say what selection already says.
let sessionId: string | null = null;

/// Bumped every time a path is opened by a click, an already-open one included.
/// What tells `App` to bring the pane forward — the count cannot, since
/// reopening an open file leaves it unchanged.
let opened = 0;

const listeners = new Set<() => void>();

/// Bumped whenever a read or a save is issued for a path, and whenever the path
/// is closed. An async answer only lands where the number it captured is still
/// current, which is what stops a slow read from writing over a newer one and
/// stops either from re-adding a doc the reader has closed.
///
/// Per path rather than one counter for the store, unlike `usePrMarks`: a
/// single number would make opening a second file discard the first file's
/// read, and one draft's edits have nothing to say about another's. Per
/// *session* as well, since two sessions holding one file hold two drafts, and
/// closing it in one must not cancel the other's read.
const seqByPath = new Map<string, number>();

function issue(sid: string, path: string): number {
  const key = `${sid}\n${path}`;
  const next = (seqByPath.get(key) ?? 0) + 1;
  seqByPath.set(key, next);
  return next;
}

function current(sid: string, path: string, seq: number): boolean {
  return seqByPath.get(`${sid}\n${path}`) === seq;
}

function state(sid: string): SessionDocs {
  return bySession.get(sid) ?? EMPTY;
}

/// Merges over what the session holds, so a caller moving one field cannot drop
/// another by forgetting to name it.
function write(sid: string, next: Partial<SessionDocs>) {
  bySession.set(sid, { ...state(sid), ...next });
  emit();
}

/// Points the store at a session's docs, from `App`'s own selection. `null`
/// where nothing is selected, which draws no panel at all.
///
/// Written during render rather than from an effect, and that is the whole
/// reason it is a hook. An effect runs *after* the commit, so the tab row and
/// the panel would each draw one frame of the previous session's docs — a tab
/// that appears and vanishes on every switch. No listener is notified: the
/// render that follows is already happening, and notifying from inside one is
/// what React forbids.
export function useDocsSession(id: string | null) {
  if (sessionId !== id) {
    sessionId = id;
    snapshot = { ...(id ? state(id) : EMPTY), opened };
  }
}

type DocsSnapshot = SessionDocs & { opened: number };

/// What `useSyncExternalStore` reads. Rebuilt in `emit` rather than on read,
/// because the getter *is* the change signal — an object built fresh each call
/// is a new identity every render, which React reads as an endless stream of
/// changes and re-renders forever.
let snapshot: DocsSnapshot = { ...EMPTY, opened };

function emit() {
  snapshot = { ...(sessionId ? state(sessionId) : EMPTY), opened };
  for (const listener of listeners) listener();
}

function find(sid: string, path: string): Doc | undefined {
  return state(sid).docs.find((doc) => doc.path === path);
}

/// Replaces one doc in place, leaving the rest and their identities alone.
/// A no-op where the path is gone, which is what most of the async guards below
/// come down to.
function patch(sid: string, path: string, next: (doc: Doc) => Doc) {
  const { docs } = state(sid);
  const at = docs.findIndex((doc) => doc.path === path);
  if (at === -1) return;
  write(sid, { docs: docs.map((doc, i) => (i === at ? next(doc) : doc)) });
}

/// Same, for the ready case alone — every rule below is about a doc whose text
/// has already arrived.
function patchReady(sid: string, path: string, next: (body: Ready) => Ready) {
  patch(sid, path, (doc) =>
    doc.body.status === "ready" ? { ...doc, body: next(doc.body) } : doc,
  );
}

/// What a click on a path in the transcript does.
///
/// Markdown is something this app already renders, so handing it to an external
/// editor would be a trip out of Dray to read a file Dray can show. Everything
/// else falls through to the reader's own editor, unchanged.
///
/// The decision lives here rather than in [openWith](../lib/openWith.ts): that
/// module is about the apps on this machine, and having it reach into a panel's
/// store would put the docs feature's own rule somewhere it cannot be read from.
export function openPath(path: string): void {
  if (isMarkdownPath(path)) return openDoc(path);
  void openFile(path);
}

/// Opens a markdown file in the panel, reading it if it is not already open.
///
/// A path that is already open is only activated. It is not re-read, which
/// would be a way for a second click on a chip's own file to throw away a draft.
export function openDoc(path: string): void {
  const sid = sessionId;
  // Nothing to open a doc *into*. The panel belongs to a session, and the one
  // route here with none selected is the issues page, which draws no panel.
  if (!sid) return;

  opened += 1;
  const { docs } = state(sid);

  if (find(sid, path)) return write(sid, { activePath: path });

  write(sid, {
    docs: [...docs, { path, mode: "view", body: { status: "loading" } }],
    activePath: path,
  });

  const seq = issue(sid, path);
  invoke<string>("read_doc", { path })
    .then((text) => {
      if (!current(sid, path, seq)) return;
      patch(sid, path, (doc) => ({
        ...doc,
        body: { status: "ready", base: text, draft: text, stale: false, saving: false, saveError: null },
      }));
    })
    .catch((err) => {
      if (!current(sid, path, seq)) return;
      patch(sid, path, (doc) => ({ ...doc, body: { status: "error", message: String(err) } }));
    });
}

/// Brings an already-open doc forward.
export function selectDoc(path: string) {
  const sid = sessionId;
  if (!sid) return;
  if (state(sid).activePath === path) return;
  write(sid, { activePath: path });
}

/// Closes a doc, discarding whatever draft it held.
///
/// Closing the active one has to leave `activePath` naming a doc that is still
/// open, or `null` once the last one goes. A strip of chips pointing at nothing
/// is what a stale `activePath` looks like on screen.
export function closeDoc(path: string) {
  const sid = sessionId;
  if (!sid) return;
  const { docs, activePath, clash } = state(sid);
  const at = docs.findIndex((doc) => doc.path === path);
  if (at === -1) return;
  // A read or save still out for this path must not write into the store after
  // the reader has closed it.
  issue(sid, path);
  const left = docs.filter((doc) => doc.path !== path);
  write(sid, {
    docs: left,
    activePath:
      activePath === path ? (left[at]?.path ?? left[at - 1]?.path ?? null) : activePath,
    // A question about a file nobody has open any more answers itself.
    clash: clash === path ? null : clash,
  });
}

/// Switches one doc between reading and writing.
export function setDocMode(path: string, mode: DocMode) {
  if (sessionId) patch(sessionId, path, (doc) => (doc.mode === mode ? doc : { ...doc, mode }));
}

/// Takes a keystroke. The draft is the only thing that moves — dirtiness is read
/// back off it, and staleness is about the file rather than about the edit.
export function setDocDraft(path: string, draft: string) {
  if (sessionId)
    patchReady(sessionId, path, (body) => (body.draft === draft ? body : { ...body, draft }));
}

/// Re-reads the file and takes it, discarding the draft. What the stale strip's
/// Reload offers.
export function reloadDoc(path: string) {
  const sid = sessionId;
  if (!sid) return;
  const doc = find(sid, path);
  if (doc?.body.status !== "ready" || doc.body.saving) return;

  const seq = issue(sid, path);
  invoke<string>("read_doc", { path })
    .then((text) => {
      if (!current(sid, path, seq)) return;
      patchReady(sid, path, (body) => ({
        ...body,
        base: text,
        draft: text,
        stale: false,
        saveError: null,
      }));
    })
    .catch((err) => {
      if (!current(sid, path, seq)) return;
      patchReady(sid, path, (body) => ({ ...body, saveError: String(err) }));
    });
}

/// Writes the draft, refusing to clobber a file that moved underneath it.
///
/// `expect` is the text this draft was made from, and the backend re-reads
/// before writing — so a save that would lose somebody else's write answers
/// `"stale"` and writes nothing. `force` sends `null` instead, which is the
/// reader saying they have been shown the clash and want their own version
/// anyway.
///
/// A clash raises `clash` for the panel to draw, and both routes into a save —
/// the button and ⌘S — go through here, so the dialog cannot be something only
/// one of them can produce.
///
/// Where the watcher has already flagged the doc, nothing is sent at all: the
/// backend could only answer `Stale`, and the round trip buys nothing. Where it
/// has not, the compare-and-swap catches it, which is what covers a file that
/// moved between the flag and the press.
export async function saveDoc(
  path: string,
  { force = false }: { force?: boolean } = {},
): Promise<SaveOutcome | null> {
  const sid = sessionId;
  if (!sid) return null;
  const doc = find(sid, path);
  if (doc?.body.status !== "ready" || doc.body.saving) return null;

  if (doc.body.stale && !force) {
    write(sid, { clash: path });
    return "stale";
  }

  // Captured now. The reader can type while the write is out, so adopting
  // whatever the draft holds when the promise resolves would mark an edit made
  // mid-save as already saved.
  const sent = doc.body.draft;
  const expect = force ? null : doc.body.base;
  const seq = issue(sid, path);

  patchReady(sid, path, (body) => ({ ...body, saving: true, saveError: null }));

  try {
    const outcome = await invoke<SaveOutcome>("save_doc", { path, text: sent, expect });
    if (!current(sid, path, seq)) return null;
    patchReady(sid, path, (body) =>
      outcome === "stale"
        ? { ...body, saving: false, stale: true }
        : { ...body, saving: false, base: sent, stale: false, saveError: null },
    );
    if (outcome === "stale") write(sid, { clash: path });
    return outcome;
  } catch (err) {
    if (!current(sid, path, seq)) return null;
    patchReady(sid, path, (body) => ({ ...body, saving: false, saveError: String(err) }));
    return null;
  }
}

/// Takes the clash dialog back down. The reader is left in edit mode with every
/// keystroke intact, which is the whole reason this is an answer and not just a
/// way out of a dialog: it is where they go to copy their version out before
/// choosing between the two that lose something.
export function dismissClash() {
  if (sessionId) write(sessionId, { clash: null });
}

/// What ⌘S calls. A no-op where there is nothing to write, so the chord is free
/// to be pressed out of habit.
export function saveActiveDoc() {
  const sid = sessionId;
  if (!sid) return;
  const { activePath } = state(sid);
  if (!activePath) return;
  const doc = find(sid, activePath);
  if (!doc || !isDirty(doc)) return;
  void saveDoc(activePath);
}

/// Re-reads the doc on screen. What ⌘R and the tab row's button call.
export function refreshActiveDoc() {
  const sid = sessionId;
  if (!sid) return;
  const path = state(sid).activePath;
  if (path) refreshDoc(path);
}

/// Re-reads one open doc, per `withDiskText` — a clean one adopts the file, a
/// dirty one is flagged and keeps its draft, which is what makes this safe to
/// fire from a watcher while somebody is typing.
///
/// The guarantee is the compare-and-swap at save time, which holds whether or
/// not anything ever re-read; this is what lets a reader find out *before* they
/// press Save rather than in a dialog after it.
///
/// A doc whose first read failed is retried outright. Refresh landing on the one
/// state with a visible error and doing nothing would be a control that provably
/// cannot help.
export function refreshDoc(path: string) {
  const sid = sessionId;
  if (!sid) return;
  const doc = find(sid, path);
  if (!doc || doc.body.status === "loading") return;
  if (doc.body.status === "ready" && doc.body.saving) return;

  const seq = issue(sid, path);
  invoke<string>("read_doc", { path })
    .then((text) => {
      if (!current(sid, path, seq)) return;
      patch(sid, path, (it) =>
        it.body.status === "ready"
          ? { ...it, body: withDiskText(it.body, text) }
          : {
              ...it,
              body: {
                status: "ready",
                base: text,
                draft: text,
                stale: false,
                saving: false,
                saveError: null,
              },
            },
      );
    })
    .catch((err) => {
      if (!current(sid, path, seq)) return;
      patch(sid, path, (it) =>
        it.body.status === "ready"
          ? { ...it, body: { ...it.body, saveError: String(err) } }
          : { ...it, body: { status: "error", message: String(err) } },
      );
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/// The current session's view of the store. Exported so the split between
/// sessions can be tested without a renderer.
export function docsSnapshot(): DocsSnapshot {
  return snapshot;
}

/// The open docs, and which one the panel is showing.
export function useDocs(): DocsSnapshot {
  return useSyncExternalStore(subscribe, docsSnapshot, docsSnapshot);
}

/// Keeps the open docs current with the files underneath them.
///
/// The watch set is re-armed whenever the open set changes — which a session
/// switch is, so a session's docs stop being watched the moment its panel is off
/// screen. An event landing after that finds nothing to patch and costs a
/// no-op.
///
/// A clean doc adopts the new text silently, which is the whole point: an agent
/// rewriting the file the reader is looking at should move the text on screen.
/// A dirty one is flagged instead and keeps every keystroke — the clash is put
/// to the reader when they save, not while they are typing.
export function useDocWatcher() {
  const { docs } = useDocs();
  // A joined key rather than the array itself, so a render that rebuilds the
  // list without changing the set does not re-arm the watcher. Only ever a
  // dependency — the paths sent are read off `docs`, never split back out of
  // this, since a newline is legal in a path.
  const key = docs.map((doc) => doc.path).join("\n");

  useEffect(() => {
    void invoke("watch_docs", { paths: docsSnapshot().docs.map((doc) => doc.path) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const un = listen<string>("doc_changed", (event) => refreshDoc(event.payload));
    return () => void un.then((off) => off());
  }, []);
}
