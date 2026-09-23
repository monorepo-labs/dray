import { memo, useState } from "react";
import { ChevronRight, GitCompare } from "lucide-react";

import FileIcon from "@/components/FileIcon";
import ShortcutKeys from "@/components/ShortcutKeys";
import Counts from "@/components/changes/Counts";
import Note, { unreadableText } from "@/components/changes/Note";
import DiffView from "@/components/chat/DiffView";
import { Button } from "@/components/ui/button";
import { useFileVersions, type useChanges } from "@/hooks/useChanges";
import { splitPath } from "@/lib/changes";
import { cn } from "@/lib/utils";
import type { ChangedFile, FileVersions } from "@/types/events";

type ChangesPanelProps = ReturnType<typeof useChanges> & {
  /// Where the agent runs. The snapshot is taken here, so for a worktree
  /// session this is the tree, not the project root.
  cwd: string;
  /// The tree id to diff against, or null when the session recorded none.
  baseline: string | null;
  /// Opens the main column's Diff view — the empty state's way out, since the
  /// question a reader asks of an empty turn is what the repository holds.
  onOpenRepo: () => void;
};

/// What the agent changed since the last prompt, file by file.
///
/// Every row starts collapsed. The list is the answer to "what did this turn
/// touch", and opening one file by position puts an arbitrary diff above that
/// list and pushes the rest of it off screen. The fetch stays per-file: a
/// collapsed row costs nothing, and a large turn fills in progressively
/// instead of blocking on one enormous read.
export default function ChangesPanel({
  cwd,
  baseline,
  changes,
  error,
  onOpenRepo,
}: ChangesPanelProps) {
  // A directory that isn't a repo records no snapshot, so there is no "before"
  // to diff — said plainly rather than dressed up as an empty change list.
  if (!baseline) {
    return <Empty>No snapshot for this session. This panel needs a git repository.</Empty>;
  }
  if (error && !changes) return <Empty tone="error">{error}</Empty>;
  if (!changes) return <Empty>Reading the working tree…</Empty>;
  // The header names a list, so with no list it is a heading over an empty
  // state — which reads as this turn being *reported* on rather than as nothing
  // having happened. The empty state says which turn it means itself.
  if (changes.files.length === 0) return <NoChanges onOpenRepo={onOpenRepo} />;

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-ui">
        <span className="text-sidebar-foreground">Last turn</span>
        <span className="text-muted-foreground">
          {changes.files.length} file{changes.files.length > 1 ? "s" : ""}
        </span>
        <Counts added={changes.added} removed={changes.removed} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {changes.files.map((file) => (
          <FileRow
            key={file.path}
            cwd={cwd}
            base={changes.base}
            head={changes.head}
            file={file}
          />
        ))}
      </div>
    </>
  );
}

/// What an empty turn looks like, and where to go instead.
///
/// One message for every way of arriving here — no turn sent yet, a turn still
/// running, a turn that only read files. They are the same fact to the reader,
/// and three sentences for one empty list would make the panel look like it was
/// reporting something.
///
/// It offers the Diff view because that is the question an empty turn raises:
/// the panel answers "what did this turn touch" and the reader's next thought
/// is what the repository holds. The browser pane's empty stage makes the same
/// bargain — a sentence alone leaves them hunting for the tab.
function NoChanges({ onOpenRepo }: { onOpenRepo: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-ui">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        {/* The glyph rides the line it labels rather than sitting over it: on
            its own row it reads as an illustration, which is more than a pane
            this size has room to mean. */}
        <p className="flex items-center gap-2 text-sidebar-foreground">
          <GitCompare className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
          No files changed this turn.
        </p>
        {/* The chord sits beside the button, not inside it: in there it reads as
            part of the label, and the button already says what it does. */}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onOpenRepo}>
            Open Diff view
          </Button>
          <ShortcutKeys ids={["view.changes"]} />
        </div>
      </div>
    </div>
  );
}

/// Centred in whatever space is left, matching the browser's empty stage.
function Empty({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <p
      className={cn(
        "flex flex-1 items-center justify-center p-8 text-center text-ui",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

/// Memoized because the panel re-renders on every session event — its
/// `revision` prop moves with the stream — while a row's own props only change
/// when a fresh read actually finds different trees (`useChanges` keeps the old
/// object otherwise). Without this every delta re-rendered every diff.
const FileRow = memo(function FileRow({
  cwd,
  base,
  head,
  file,
}: {
  cwd: string;
  base: string;
  head: string;
  file: ChangedFile;
}) {
  // The reader's own opens and closes stick across refreshes, since rows key
  // by path.
  const [open, setOpen] = useState(false);
  // A binary file is listed — it did change — but there is nothing to open.
  const expandable = !file.binary;
  const { versions, error } = useFileVersions(cwd, base, head, file, open && expandable);

  const { dir, name } = splitPath(file.path);

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => expandable && setOpen((prev) => !prev)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2.5 text-left text-ui",
          expandable ? "transition-colors hover:bg-sidebar-accent/50" : "cursor-default",
        )}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            !expandable && "invisible",
          )}
        />
        <FileIcon path={file.path} />

        <span className="min-w-0 flex-1 truncate">
          {/* Reversed against reading order on purpose: the directory is
              scanned past, so it is what gets clipped when space runs out. */}
          <span className="text-muted-foreground">{dir}</span>
          <span className="text-sidebar-foreground">{name}</span>
          {file.oldPath && (
            <span className="text-muted-foreground"> ← {splitPath(file.oldPath).name}</span>
          )}
        </span>

        {file.binary ? (
          <span className="shrink-0 text-muted-foreground">binary</span>
        ) : (
          <Counts added={file.added} removed={file.removed} />
        )}
      </button>

      {open && expandable && (
        <FileBody versions={versions} error={error} path={file.path} />
      )}
    </div>
  );
});

function FileBody({
  versions,
  error,
  path,
}: {
  versions: FileVersions | null;
  error: string | null;
  path: string;
}) {
  const rule = "border-t border-border";
  if (error) return <Note text={error} error className={rule} />;
  if (!versions) return <Note text="Loading…" className={rule} />;
  if (versions.unreadable) {
    return <Note text={unreadableText(versions.unreadable)} className={rule} />;
  }

  // Full bleed: the panel is narrow, and a rounded inset card inside a list of
  // them spends horizontal space on framing the row header already does. Only
  // the top border survives, to part the code from its own header.
  //
  // A deletion's new side is null, which the viewer reads as an empty file and
  // renders as a full removal. An addition's old side stays null, which is how
  // it draws as new rather than as a diff against nothing.
  return (
    <DiffView
      sides={{ path, oldText: versions.oldText, newText: versions.newText ?? "" }}
      // `border-0` before `border-t` on purpose: zeroing all four then adding
      // one back is the ordering Tailwind emits, where per-side `border-*-0`
      // against the base `border` depends on stylesheet order to win.
      className="rounded-none border-0 border-t border-border"
    />
  );
}
