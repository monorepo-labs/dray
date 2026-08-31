import { useSyncExternalStore } from "react";

import { invoke } from "@tauri-apps/api/core";

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

/// Open docs, in the order they were opened.
///
/// Keyed by absolute path and held for the whole app rather than per session,
/// for two reasons. A file on disk is one thing, so two sessions each holding
/// their own draft of it would be a race with nothing on screen to see it
/// happen. And an open doc has to survive a session switch — the same bargain
/// the panel's hide-don't-unmount makes, since the reader's place in a file is
/// as much context as their scroll position in a diff.
///
/// The cost is that a doc opened from one project's transcript stays on screen
/// while another session is selected. Its full path is on the chip's `title`.
let docs: Doc[] = [];
let activePath: string | null = null;
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
/// read, and one draft's edits have nothing to say about another's.
const seqByPath = new Map<string, number>();

function issue(path: string): number {
  const next = (seqByPath.get(path) ?? 0) + 1;
  seqByPath.set(path, next);
  return next;
}

function current(path: string, seq: number): boolean {
  return seqByPath.get(path) === seq;
}

type DocsSnapshot = { docs: Doc[]; activePath: string | null; opened: number };

/// What `useSyncExternalStore` reads. Rebuilt in `emit` rather than on read,
/// because the getter *is* the change signal — an object built fresh each call
/// is a new identity every render, which React reads as an endless stream of
/// changes and re-renders forever.
let snapshot: DocsSnapshot = { docs, activePath, opened };

function emit() {
  snapshot = { docs, activePath, opened };
  for (const listener of listeners) listener();
}

function find(path: string): Doc | undefined {
  return docs.find((doc) => doc.path === path);
}

/// Replaces one doc in place, leaving the rest and their identities alone.
/// A no-op where the path is gone, which is what most of the async guards below
/// come down to.
function patch(path: string, next: (doc: Doc) => Doc) {
  const at = docs.findIndex((doc) => doc.path === path);
  if (at === -1) return;
  docs = docs.map((doc, i) => (i === at ? next(doc) : doc));
  emit();
}

/// Same, for the ready case alone — every rule below is about a doc whose text
/// has already arrived.
function patchReady(path: string, next: (body: Ready) => Ready) {
  patch(path, (doc) =>
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
  opened += 1;
  activePath = path;

  if (find(path)) return emit();

  docs = [...docs, { path, mode: "view", body: { status: "loading" } }];
  emit();

  const seq = issue(path);
  invoke<string>("read_doc", { path })
    .then((text) => {
      if (!current(path, seq)) return;
      patch(path, (doc) => ({
        ...doc,
        body: { status: "ready", base: text, draft: text, stale: false, saving: false, saveError: null },
      }));
    })
    .catch((err) => {
      if (!current(path, seq)) return;
      patch(path, (doc) => ({ ...doc, body: { status: "error", message: String(err) } }));
    });
}

/// Brings an already-open doc forward.
export function selectDoc(path: string) {
  if (activePath === path) return;
  activePath = path;
  emit();
}

/// Closes a doc, discarding whatever draft it held.
///
/// Closing the active one has to leave `activePath` naming a doc that is still
/// open, or `null` once the last one goes. A strip of chips pointing at nothing
/// is what a stale `activePath` looks like on screen.
export function closeDoc(path: string) {
  const at = docs.findIndex((doc) => doc.path === path);
  if (at === -1) return;
  // A read or save still out for this path must not write into the store after
  // the reader has closed it.
  issue(path);
  docs = docs.filter((doc) => doc.path !== path);
  if (activePath === path) {
    activePath = docs[at]?.path ?? docs[at - 1]?.path ?? null;
  }
  emit();
}

/// Switches one doc between reading and writing.
export function setDocMode(path: string, mode: DocMode) {
  patch(path, (doc) => (doc.mode === mode ? doc : { ...doc, mode }));
}

/// Takes a keystroke. The draft is the only thing that moves — dirtiness is read
/// back off it, and staleness is about the file rather than about the edit.
export function setDocDraft(path: string, draft: string) {
  patchReady(path, (body) => (body.draft === draft ? body : { ...body, draft }));
}

/// Re-reads the file and takes it, discarding the draft. What the stale strip's
/// Reload offers.
export function reloadDoc(path: string) {
  const doc = find(path);
  if (doc?.body.status !== "ready" || doc.body.saving) return;

  const seq = issue(path);
  invoke<string>("read_doc", { path })
    .then((text) => {
      if (!current(path, seq)) return;
      patchReady(path, (body) => ({
        ...body,
        base: text,
        draft: text,
        stale: false,
        saveError: null,
      }));
    })
    .catch((err) => {
      if (!current(path, seq)) return;
      patchReady(path, (body) => ({ ...body, saveError: String(err) }));
    });
}

/// Writes the draft, refusing to clobber a file that moved underneath it.
///
/// `expect` is the text this draft was made from, and the backend re-reads
/// before writing — so a save that would lose somebody else's write answers
/// `"stale"` and writes nothing. `force` sends `null` instead, which is the
/// reader saying they have read the strip and want their own version anyway.
export function saveDoc(path: string, { force = false }: { force?: boolean } = {}) {
  const doc = find(path);
  if (doc?.body.status !== "ready" || doc.body.saving) return;

  // Captured now. The reader can type while the write is out, so adopting
  // whatever the draft holds when the promise resolves would mark an edit made
  // mid-save as already saved.
  const sent = doc.body.draft;
  const expect = force ? null : doc.body.base;
  const seq = issue(path);

  patchReady(path, (body) => ({ ...body, saving: true, saveError: null }));

  invoke<SaveOutcome>("save_doc", { path, text: sent, expect })
    .then((outcome) => {
      if (!current(path, seq)) return;
      patchReady(path, (body) =>
        outcome === "stale"
          ? { ...body, saving: false, stale: true }
          : { ...body, saving: false, base: sent, stale: false, saveError: null },
      );
    })
    .catch((err) => {
      if (!current(path, seq)) return;
      patchReady(path, (body) => ({ ...body, saving: false, saveError: String(err) }));
    });
}

/// What ⌘S calls. A no-op where there is nothing to write, so the chord is free
/// to be pressed out of habit.
export function saveActiveDoc() {
  if (!activePath) return;
  const doc = find(activePath);
  if (!doc || !isDirty(doc)) return;
  saveDoc(activePath);
}

/// Re-reads the doc on screen, per `withDiskText` — a clean one adopts the file,
/// a dirty one is flagged and keeps its draft.
///
/// A courtesy, and only for the active doc. The guarantee is the compare-and-
/// swap at save time, which holds whether or not anything ever re-read; this
/// exists so a reader watching an agent write the file they have open finds out
/// before they press Save. Background docs are left alone, since a flag nobody
/// is looking at buys nothing and every read is a round trip.
///
/// A doc whose first read failed is retried outright. ⌘R and the tab row's one
/// button both land here, and a Refresh that did nothing on the one state with
/// a visible error would be a control that provably cannot help.
export function refreshActiveDoc() {
  if (!activePath) return;
  const path = activePath;
  const doc = find(path);
  if (!doc || doc.body.status === "loading") return;
  if (doc.body.status === "ready" && doc.body.saving) return;

  const seq = issue(path);
  invoke<string>("read_doc", { path })
    .then((text) => {
      if (!current(path, seq)) return;
      patch(path, (it) =>
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
      if (!current(path, seq)) return;
      patch(path, (it) =>
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

function getSnapshot() {
  return snapshot;
}

/// The open docs, and which one the panel is showing.
export function useDocs(): DocsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
