import { useState } from "react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  closeDoc,
  isDirty,
  reloadDoc,
  saveDoc,
  selectDoc,
  setDocDraft,
  setDocMode,
  useDocs,
  type Doc,
  type DocMode,
} from "@/hooks/useDocs";
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
export default function DocsPanel() {
  const { docs, activePath } = useDocs();
  // Named by path rather than held as the doc, so the dialog cannot go on
  // asking about a file that has since been closed from somewhere else.
  const [confirming, setConfirming] = useState<string | null>(null);

  const active = docs.find((doc) => doc.path === activePath) ?? null;

  const close = (doc: Doc) => {
    if (isDirty(doc)) return setConfirming(doc.path);
    closeDoc(doc.path);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* One row, not two. With a single file open, a strip of chips and a
          separate filename header say the same thing twice. */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {docs.map((doc) => (
            <Chip
              key={doc.path}
              doc={doc}
              active={doc.path === activePath}
              onSelect={() => selectDoc(doc.path)}
              onClose={() => close(doc)}
            />
          ))}
        </div>

        {/* Only while there is something to write. A Save that is always drawn
            and mostly disabled explains nothing about why it cannot be
            pressed. */}
        {active && isDirty(active) && (
          <Button
            size="sm"
            // Full strength while the write is out: the spinner beside the verb
            // is the state, and dimming it too makes the one live thing in the
            // row the hardest part of it to read.
            className="shrink-0 disabled:opacity-100"
            disabled={active.body.status === "ready" && active.body.saving}
            onClick={() => saveDoc(active.path)}
          >
            {active.body.status === "ready" && active.body.saving && (
              <Loader2 className="animate-spin" />
            )}
            Save
          </Button>
        )}

        {active && (
          <ModeToggle
            value={active.mode}
            onChange={(mode) => setDocMode(active.path, mode)}
          />
        )}
      </div>

      {active && <Strip doc={active} />}

      <div className="min-h-0 flex-1 overflow-auto">
        {active && <Body doc={active} />}
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
  onSelect,
  onClose,
}: {
  doc: Doc;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { name } = splitPath(doc.path);

  return (
    // The two buttons sit side by side inside the chip rather than nested, so
    // each is its own tab stop and neither is a control inside a control.
    <div
      // `title` carries the full path, which is the one thing this row is
      // truncating — and the only place a doc opened from another project's
      // transcript says where it came from.
      title={doc.path}
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

      {isDirty(doc) && (
        <span aria-label="Unsaved" className="size-1.5 shrink-0 rounded-full bg-current" />
      )}

      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${name}`}
        className="shrink-0 rounded-sm p-0.5 opacity-60 transition-opacity hover:opacity-100"
      >
        <X className="size-3" strokeWidth={1.5} />
      </button>
    </div>
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
    <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
      {MODES.map(({ value: mode, label, Icon }) => (
        <Tooltip key={mode}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onChange(mode)}
              aria-label={label}
              aria-pressed={value === mode}
              className={cn(
                "rounded-[min(var(--radius-md),6px)] p-1 transition-colors",
                value === mode
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" strokeWidth={1.5} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/// What the reader has to settle before the body means anything.
///
/// Neither Reload nor Overwrite takes the destructive fill, because both lose
/// something: one drops the reader's edits, the other drops whatever wrote the
/// file underneath them. Red belongs on the one irreversible thing in a
/// dialog, and here there are two of them with nothing to choose between on
/// colour alone.
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
            Reload
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => saveDoc(doc.path, { force: true })}
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
    return <p className="px-3 py-2 text-ui text-muted-foreground">Reading the file…</p>;
  }
  if (doc.body.status === "error") {
    return <p className="px-3 py-2 text-ui text-destructive">{doc.body.message}</p>;
  }

  if (doc.mode === "view") {
    return (
      <div className="px-3 py-2">
        {/* `linkFilePaths` stays off. It is on for the assistant's own messages
            alone, and a doc's relative links are markdown the author wrote —
            Streamdown's business, not this app's. */}
        <Markdown>{doc.body.draft}</Markdown>
      </div>
    );
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
    <AlertDialog open={path !== null} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close without saving?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">
              {path && splitPath(path).name}
            </span>{" "}
            has unsaved edits. Closing it here discards them. The file on disk is
            untouched.
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
