import { Eye, Loader2, Pencil } from "lucide-react";

import IconToggle from "@/components/IconToggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  isDirty,
  reloadDoc,
  saveDoc,
  setDocDraft,
  setDocMode,
  useDocs,
  type Doc,
  type DocMode,
} from "@/hooks/useDocs";
import { splitPath } from "@/lib/changes";
import { cn } from "@/lib/utils";

// The pieces of editing a markdown file, shared by the Docs panel and the Files
// view so the two cannot drift: one Save, one stale strip, one discard dialog.
// `store` is the docs store key the doc lives under — a session's own for the
// panel, `filesDocKey` for the Files view.

/// Save, drawn only while there is something to write. A Save that is always
/// drawn and mostly disabled explains nothing about why it cannot be pressed.
export function DocSaveButton({ store, doc }: { store: string | null; doc: Doc }) {
  if (!isDirty(doc)) return null;
  const saving = doc.body.status === "ready" && doc.body.saving;
  return (
    <Button
      size="sm"
      variant="outline"
      // Full strength while the write is out: the spinner beside the verb is
      // the state, and dimming it too makes the one live thing in the row the
      // hardest part of it to read.
      className="shrink-0 disabled:opacity-100"
      disabled={saving}
      onClick={() => void saveDoc(store, doc.path)}
    >
      {saving && <Loader2 className="animate-spin" />}
      Save
    </Button>
  );
}

const MODES: { value: DocMode; label: string; Icon: typeof Eye }[] = [
  { value: "view", label: "Read", Icon: Eye },
  { value: "edit", label: "Edit", Icon: Pencil },
];

/// Read or Edit, per doc rather than one setting for the surface: a reader
/// flipping their notes into edit mode has said nothing about the readme beside
/// it.
export function DocModeToggle({ store, doc }: { store: string | null; doc: Doc }) {
  return (
    <IconToggle value={doc.mode} options={MODES} onChange={(mode) => setDocMode(store, doc.path, mode)} />
  );
}

/// Save and Read/Edit for a markdown file in the Files view, drawn in the
/// titlebar beside Open — that view's tabs live in the titlebar, so it is the
/// row the Docs panel's chip strip is. Nothing until the viewer has synced the
/// file into the store.
export function DocControls({ store, path }: { store: string; path: string }) {
  const doc = useDocs(store).docs.find((d) => d.path === path);
  if (!doc) return null;
  return (
    <>
      <DocSaveButton store={store} doc={doc} />
      <DocModeToggle store={store} doc={doc} />
    </>
  );
}

/// The Docs panel chip's unsaved dot, for a Files tab: on the tab's icon,
/// amber where the file has also moved on disk.
export function DocTabIcon({ store, path, children }: { store: string; path: string; children: React.ReactNode }) {
  const doc = useDocs(store).docs.find((d) => d.path === path);
  if (!doc || !isDirty(doc)) return <>{children}</>;
  const stale = doc.body.status === "ready" && doc.body.stale;
  return (
    <span className="relative flex shrink-0">
      {children}
      <span
        aria-label={stale ? "Unsaved, and changed on disk" : "Unsaved"}
        className={cn(
          "absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-2 ring-background",
          stale ? "bg-accent-command" : "bg-foreground",
        )}
      />
    </span>
  );
}

/// What the reader has to settle before the body means anything.
///
/// The watcher is what puts this up now. It used to appear only after a save had
/// already bounced off the backend's compare-and-swap; the file moving is what
/// raises it today, so the reader is told while they still have somewhere to go
/// with it rather than at the press. A clean doc never gets here — it adopts the
/// new text — so this row only ever stands over edits worth keeping.
///
/// "Discard my edits" rather than "Reload", because reloading is what the button
/// *does* and losing the draft is what it *costs*, and the cost is the part
/// worth reading before clicking. Neither it nor Overwrite takes the destructive
/// fill: both lose something — one the reader's edits, the other whatever wrote
/// the file underneath them — and red on one of a matched pair says the other is
/// safe.
export function DocStaleStrip({ store, doc }: { store: string | null; doc: Doc }) {
  if (doc.body.status !== "ready") return null;
  const { stale, saveError } = doc.body;
  if (!stale && !saveError) return null;

  return (
    <div className="shrink-0 space-y-1.5 border-b border-border px-3 py-2 text-ui">
      {stale && (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-muted-foreground">
            This file changed on disk since you opened it.
          </span>
          <Button size="sm" variant="outline" onClick={() => reloadDoc(store, doc.path)}>
            Discard my edits
          </Button>
          <Button size="sm" variant="outline" onClick={() => void saveDoc(store, doc.path, { force: true })}>
            Overwrite
          </Button>
        </div>
      )}
      {saveError && <p className="text-destructive">{saveError}</p>}
    </div>
  );
}

/// The draft, in a plain textarea rather than an editor library. Native undo,
/// the caret and IME all come free, and the app takes no new dependency.
export function DocTextarea({
  store,
  doc,
  className,
}: {
  store: string | null;
  doc: Doc;
  className?: string;
}) {
  if (doc.body.status !== "ready") return null;
  return (
    <textarea
      // Per doc, so switching files gives each its own element and the caret
      // cannot arrive in one file where it was left in another.
      key={doc.path}
      value={doc.body.draft}
      onChange={(e) => setDocDraft(store, doc.path, e.target.value)}
      spellCheck={false}
      // Tab is deliberately left alone: stealing it takes the keyboard's way
      // out of this box, and markdown lists need no indent to be written.
      className={cn("h-full w-full resize-none bg-transparent px-3 py-2 font-mono text-code outline-none", className)}
    />
  );
}

/// "Close without saving?", for a doc with unsaved edits.
export function DiscardConfirm({
  path,
  onConfirm,
  onClose,
}: {
  path: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog open={path !== null} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close without saving?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{path && splitPath(path).name}</span> has
            unsaved edits. Closing it here discards them. The file on disk is untouched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction destructive onClick={onConfirm}>
            Discard edits
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
