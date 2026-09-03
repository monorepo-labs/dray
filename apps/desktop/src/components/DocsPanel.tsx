import { useEffect, useMemo, useState } from "react";
import { Eye, Loader2, Pencil, X } from "lucide-react";

import FileIcon from "@/components/FileIcon";
import { Markdown } from "@/components/chat/Markdown";
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
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  closeDoc,
  isDirty,
  reloadDoc,
  saveDoc,
  selectDoc,
  setDocDraft,
  setDocMode,
  useDocs,
  useDocWatcher,
  type Doc,
  type DocMode,
} from "@/hooks/useDocs";
import { useHotkey } from "@/hooks/useHotkey";
import { splitPath } from "@/lib/changes";
import {
  FIRST_SECTIONS,
  SECTION_STEP,
  splitMarkdownSections,
} from "@/lib/markdown";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";

/// A markdown file from the transcript, rendered and editable.
///
/// A plain textarea rather than an editor library. Native undo, the caret and
/// IME all come free, the app takes no new dependency, and the composer next
/// door already proves the mirrored-overlay technique is here if syntax
/// colouring is ever wanted for this too.
///
/// Reads the store directly rather than taking it as props. `App` holds the
/// hook because the tab row has to know whether the tab exists before this is
/// ever drawn, but every mutator is already a module-level export — so
/// threading them through would put the panel's whole surface into `App`'s JSX
/// to say what `useDocs` says here.
///
/// No empty state: the tab is only drawn while something is open.
export default function DocsPanel({
  sessionId,
  active,
}: {
  /// Whose docs to draw. Taken as a prop rather than read off the store's own
  /// notion of a current session, so this panel and `App`'s tab row cannot
  /// disagree about which session they are describing.
  sessionId: string | null;
  /// False while the panel is closed, another tab is showing, or the reader is
  /// on the changes view. Only the chord reads it — the panel stays mounted
  /// either way — and `useHotkey` claims every chord it matches, so a binding
  /// left registered would take ⌘⇧← from the changes sub-tab row and from the
  /// composer, where it selects to the start of the line.
  active: boolean;
}) {
  const { docs, activePath } = useDocs(sessionId);
  useDocWatcher(sessionId);
  // Named by path rather than held as the doc, so the dialog cannot go on
  // asking about a file that has since been closed from somewhere else.
  const [confirming, setConfirming] = useState<string | null>(null);

  const current = docs.find((doc) => doc.path === activePath) ?? null;

  // ⌘⇧← / ⌘⇧→ step the chips, the same shape ⌘⇧↑/↓ steps the session list and
  // the changes sub-tab row steps its own. Clamped rather than wrapped, for
  // that row's reason: wrapping makes ← from the first chip the long way round
  // to the last.
  //
  // Held back while the open doc is being edited: the body is then a textarea,
  // where ⌘⇧← is select-to-line-start and the reader is far likelier to mean
  // that than to mean the chip beside it.
  const step = (delta: number) => {
    const next = docs[docs.findIndex((doc) => doc.path === activePath) + delta];
    if (next) selectDoc(next.path);
  };
  const stepping = active && current?.mode === "view";
  useHotkey("ArrowLeft", () => step(-1), { shift: true, enabled: stepping });
  useHotkey("ArrowRight", () => step(1), { shift: true, enabled: stepping });

  const close = (doc: Doc) => {
    // Stated here as well as on the button, which is disabled for it: the
    // dialog this opens promises the file is untouched, and a save already
    // with the OS makes that untrue.
    if (doc.body.status === "ready" && doc.body.saving) return;
    if (isDirty(doc)) return setConfirming(doc.path);
    closeDoc(doc.path);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* One row, not two. With a single file open, a strip of chips and a
          separate filename header say the same thing twice. */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {docs.map((doc) => (
            <Chip
              key={doc.path}
              doc={doc}
              active={doc.path === activePath}
              onSelect={() => selectDoc(doc.path)}
              onClose={() => close(doc)}
              // Only where the chord would actually fire: one chip is a row
              // with nothing to step to, and an edit-mode doc has the chord
              // held back, so drawing the cap there names a key that does
              // nothing.
              chord={stepping && docs.length > 1}
            />
          ))}
        </div>

        {/* Only while there is something to write. A Save that is always drawn
            and mostly disabled explains nothing about why it cannot be
            pressed. */}
        {current && isDirty(current) && (
          <Button
            size="sm"
            variant="outline"
            // Full strength while the write is out: the spinner beside the verb
            // is the state, and dimming it too makes the one live thing in the
            // row the hardest part of it to read.
            className="shrink-0 disabled:opacity-100"
            disabled={current.body.status === "ready" && current.body.saving}
            onClick={() => void saveDoc(current.path)}
          >
            {current.body.status === "ready" && current.body.saving && (
              <Loader2 className="animate-spin" />
            )}
            Save
          </Button>
        )}

        {current && (
          <ModeToggle
            value={current.mode}
            onChange={(mode) => setDocMode(current.path, mode)}
          />
        )}
      </div>

      {current && <Strip doc={current} />}

      <div className="min-h-0 flex-1 overflow-auto">
        {current && <Body doc={current} />}
      </div>

      <CloseConfirm
        path={confirming}
        onConfirm={() => {
          if (confirming) closeDoc(confirming);
          setConfirming(null);
        }}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}

function Chip({
  doc,
  active,
  chord,
  onSelect,
  onClose,
}: {
  doc: Doc;
  active: boolean;
  chord: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { name } = splitPath(doc.path);
  const saving = doc.body.status === "ready" && doc.body.saving;
  const stale = doc.body.status === "ready" && doc.body.stale;

  return (
    // Keycaps alone, like the changes sub-tab row: the filename is on the chip
    // and the tooltip's whole job is to name the chord. The full path was drawn
    // here and is gone — a tooltip that opens on every hover to repeat what the
    // chip already says is one the reader learns to ignore, which costs the
    // shortcut its only place to be discovered.
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The two buttons sit side by side inside the chip rather than nested,
            so each is its own tab stop and neither is a control inside a
            control. */}
        <div
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md pl-1.5 pr-1 text-ui",
            active
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <button
            type="button"
            onClick={onSelect}
            className="flex min-w-0 items-center gap-1.5 py-1"
          >
            <FileIcon path={doc.path} className="size-3.5" />
            <span className="max-w-40 truncate">{name}</span>
          </button>

          {/* Amber where the file has also moved on disk, the same yellow the
              sidebar's "waiting on you" rail mark takes — it says the same
              thing, that this one has something the reader has to settle. The
              dialog only comes at the save, so this is the whole of the warning
              until then. */}
          {isDirty(doc) && (
            <span
              aria-label={stale ? "Unsaved, and changed on disk" : "Unsaved"}
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                stale ? "bg-accent-command" : "bg-current",
              )}
            />
          )}

          {/* Held back while a save is out, because closing cannot call it off.
          The write is already with the OS, so "Discard edits" would name
          something this app can no longer do — and the file would land with
          the very text the reader was told had been thrown away. A save is a
          keystroke's worth of wait; the button comes back on its own. */}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label={`Close ${name}`}
            className="shrink-0 rounded-sm p-0.5 opacity-60 transition-opacity hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
          >
            <X className="size-3" strokeWidth={1.5} />
          </button>
        </div>
      </TooltipTrigger>

      {/* Nothing to say where the chord cannot fire, and an empty box under the
          cursor is worse than no box — so the tooltip is withheld outright
          rather than drawn holding nothing. */}
      {chord && (
        <TooltipContent side="bottom" className="px-1.5">
          <KbdGroup>
            <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
            {/* Spelled out beside arrow keys, the sidebar's rule: ⇧ is an
                arrow, so the glyph reads as a third one. */}
            <Kbd>Shift</Kbd>
            <Kbd>←→</Kbd>
          </KbdGroup>
        </TooltipContent>
      )}
    </Tooltip>
  );
}

const MODES: { value: DocMode; label: string; Icon: typeof Eye }[] = [
  { value: "view", label: "Read", Icon: Eye },
  { value: "edit", label: "Edit", Icon: Pencil },
];

/// Both options drawn, with the active one filled — the same control the diff
/// pane's split/unified toggle is, and for its reason: a single glyph that
/// swapped on click reads as a picture of the current state rather than as
/// something that can be pressed.
///
/// Per doc, not one setting for the panel. A reader flipping their notes into
/// edit mode has said nothing about the readme in the chip beside it.
function ModeToggle({
  value,
  onChange,
}: {
  value: DocMode;
  onChange: (next: DocMode) => void;
}) {
  return (
    // `--surface-well`, the track token, rather than a muted fill: the well is
    // a black scrim in both modes, so on a light page it cuts *into* the row
    // instead of sitting a shade off it — which is what lets the thumb read as
    // raised rather than as the one segment that happens to be greyer.
    <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-surface-well p-0.5">
      {/* No tooltip. Both options are drawn side by side, so the pair says what
          each one does by contrast — a tooltip naming the glyph under the
          cursor tells the reader what they can already see. `aria-label` still
          carries the word for anyone not reading the shape. */}
      {MODES.map(({ value: mode, label, Icon }) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          aria-label={label}
          aria-pressed={value === mode}
          className={cn(
            "rounded-[min(var(--radius-md),6px)] p-1 transition-colors",
            // The thumb has to come up past the surface the row is drawn at,
            // out of the well the track cuts — so it takes `--surface-thumb`
            // and the button shadow, the pair the composer's own segmented
            // control uses. An accent fill is a veil, and a veil over a scrim
            // is a few percent of light that reads as nothing.
            value === mode
              ? "bg-surface-thumb text-foreground shadow-(--shadow-button)"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" strokeWidth={1.5} />
        </button>
      ))}
    </div>
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
function Strip({ doc }: { doc: Doc }) {
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
          <Button size="sm" variant="outline" onClick={() => reloadDoc(doc.path)}>
            Discard my edits
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void saveDoc(doc.path, { force: true })}
          >
            Overwrite
          </Button>
        </div>
      )}
      {saveError && <p className="text-destructive">{saveError}</p>}
    </div>
  );
}

function Body({ doc }: { doc: Doc }) {
  if (doc.body.status === "loading") {
    return (
      <p className="px-3 py-2 text-ui text-muted-foreground">
        Reading the file…
      </p>
    );
  }
  if (doc.body.status === "error") {
    return (
      <p className="px-3 py-2 text-ui text-destructive">{doc.body.message}</p>
    );
  }

  if (doc.mode === "view") {
    // Keyed on the path so switching chips starts the next document at its own
    // top rather than inheriting how far the last one had mounted.
    return <Rendered key={doc.path} text={doc.body.draft} />;
  }

  return (
    <textarea
      // Per doc, so switching chips gives each file its own element and the
      // caret cannot arrive in one file where it was left in another. The tab
      // being hidden keeps this mounted either way.
      key={doc.path}
      value={doc.body.draft}
      onChange={(e) => setDocDraft(doc.path, e.target.value)}
      spellCheck={false}
      // Tab is deliberately left alone: stealing it takes the keyboard's way
      // out of this box, and markdown lists need no indent to be written.
      className="h-full w-full resize-none bg-transparent px-3 py-2 font-mono text-code outline-none"
    />
  );
}

/// The document, mounted a few sections at a time.
///
/// One commit was what made a long file take seconds to open: 282KB of markdown
/// measured at 930ms of parsing before any of the 608KB of HTML it produces
/// reached the DOM, and the commit and layout of that tree after it. A reader
/// opens a document at its top, so the top is what has to be on screen — the
/// rest arrives behind it, which is the bargain the transcript's own backfill
/// makes for a long session.
///
/// The total work is unchanged. What changes is that the main thread comes back
/// between steps, so the panel is readable and scrollable throughout instead of
/// frozen until the last section lands.
function Rendered({ text }: { text: string }) {
  const sections = useMemo(() => splitMarkdownSections(text), [text]);
  const [mounted, setMounted] = useState(FIRST_SECTIONS);

  useEffect(() => {
    if (mounted >= sections.length) return;
    // A macrotask rather than a frame: this is parse work, and yielding to the
    // event loop is what keeps a click or a keystroke from queueing behind it.
    const id = setTimeout(() => setMounted((n) => n + SECTION_STEP), 0);
    return () => clearTimeout(id);
  }, [mounted, sections.length]);

  return (
    <div className="px-3 py-2">
      {sections.slice(0, mounted).map((section, i) => (
        // `Markdown` strips its own first child's top margin, which is right for
        // one message in a transcript and wrong for a section stacked under
        // another — without this every heading after the first would sit flush
        // against the paragraph above it.
        <div key={i} className={i > 0 ? "mt-4" : undefined}>
          {/* `linkFilePaths` stays off. It is on for the assistant's own
              messages alone, and a doc's relative links are markdown the author
              wrote — Streamdown's business, not this app's. */}
          <Markdown>{section}</Markdown>
        </div>
      ))}
    </div>
  );
}

function CloseConfirm({
  path,
  onConfirm,
  onClose,
}: {
  path: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog
      open={path !== null}
      onOpenChange={(next) => !next && onClose()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close without saving?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">
              {path && splitPath(path).name}
            </span>{" "}
            has unsaved edits. Closing it here discards them. The file on disk
            is untouched.
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
