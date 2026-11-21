import { useState } from "react";
import { X } from "lucide-react";

import {
  DiscardConfirm,
  DocModeToggle,
  DocSaveButton,
  DocStaleStrip,
  DocTextarea,
} from "@/components/DocEditing";
import FileIcon from "@/components/FileIcon";
import MarkdownDoc from "@/components/MarkdownDoc";
import ShortcutKeys from "@/components/ShortcutKeys";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  closeDoc,
  isDirty,
  selectDoc,
  useDocs,
  useDocWatcher,
  type Doc,
} from "@/hooks/useDocs";
import { useHotkey } from "@/hooks/useHotkey";
import { splitPath } from "@/lib/changes";
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
    if (next) selectDoc(sessionId, next.path);
  };
  const stepping = active && current?.mode === "view";
  // Given up in a text field too: the composer is on screen beside a doc in
  // read mode, and ⌘⇧← selects to the start of a line there.
  const chord = { enabled: stepping, skipInTextField: true };
  useHotkey("subtab.prev", () => step(-1), chord);
  useHotkey("subtab.next", () => step(1), chord);

  const close = (doc: Doc) => {
    // Stated here as well as on the button, which is disabled for it: the
    // dialog this opens promises the file is untouched, and a save already
    // with the OS makes that untrue.
    if (doc.body.status === "ready" && doc.body.saving) return;
    if (isDirty(doc)) return setConfirming(doc.path);
    closeDoc(sessionId, doc.path);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* One row, not two. With a single file open, a strip of chips and a
          separate filename header say the same thing twice. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 pt-3 pb-2">
        <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {docs.map((doc) => (
            <Chip
              key={doc.path}
              doc={doc}
              active={doc.path === activePath}
              onSelect={() => selectDoc(sessionId, doc.path)}
              onClose={() => close(doc)}
              // Only where the chord would actually fire: one chip is a row
              // with nothing to step to, and an edit-mode doc has the chord
              // held back, so drawing the cap there names a key that does
              // nothing.
              chord={stepping && docs.length > 1}
            />
          ))}
        </div>

        {current && <DocSaveButton store={sessionId} doc={current} />}
        {current && <DocModeToggle store={sessionId} doc={current} />}
      </div>

      {current && <DocStaleStrip store={sessionId} doc={current} />}

      <div className="min-h-0 flex-1 overflow-auto">
        {current && <Body sessionId={sessionId} doc={current} />}
      </div>

      <DiscardConfirm
        path={confirming}
        onConfirm={() => {
          if (confirming) closeDoc(sessionId, confirming);
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
          <ShortcutKeys ids={["subtab.prev", "subtab.next"]} />
        </TooltipContent>
      )}
    </Tooltip>
  );
}

function Body({ sessionId, doc }: { sessionId: string | null; doc: Doc }) {
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
    return <MarkdownDoc key={doc.path} text={doc.body.draft} />;
  }

  return <DocTextarea store={sessionId} doc={doc} />;
}
