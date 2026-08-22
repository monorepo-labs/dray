import { memo, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";

import FileIcon from "@/components/FileIcon";
import DiffView from "@/components/chat/DiffView";
import { Button } from "@/components/ui/button";
import { useChanges, useFileVersions } from "@/hooks/useChanges";
import { splitPath } from "@/lib/changes";
import { cn } from "@/lib/utils";
import type { ChangedFile, FileVersions } from "@/types/events";

type ChangesPanelProps = {
  /// Where the agent runs. The snapshot is taken here, so for a worktree
  /// session this is the tree, not the project root.
  cwd: string;
  /// The tree id to diff against, or null when the session recorded none.
  baseline: string | null;
  /// The turn's closing snapshot — the frozen "after" side. Null while the
  /// turn runs, which diffs against the working tree as it stands now.
  head: string | null;
  /// Changes whenever the agent may have written something.
  revision: string;
  /// False while the panel is closed or another tab is showing. The component
  /// stays mounted either way; this only pauses re-reads.
  active: boolean;
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
  head,
  revision,
  active,
}: ChangesPanelProps) {
  const { changes, error, loading, refresh } = useChanges(cwd, baseline, head, revision, active);

  // A directory that isn't a repo records no snapshot, so there is no "before"
  // to diff — said plainly rather than dressed up as an empty change list.
  if (!baseline) {
    return <Empty>No snapshot for this session. This panel needs a git repository.</Empty>;
  }
  if (error && !changes) return <Empty tone="error">{error}</Empty>;
  if (!changes) return <Empty>Reading the working tree…</Empty>;

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-ui">
        <span className="text-sidebar-foreground">Last turn</span>

        {changes.files.length ? (
          <>
            <span className="text-muted-foreground">
              {changes.files.length} file{changes.files.length > 1 ? "s" : ""}
            </span>
            <Counts added={changes.added} removed={changes.removed} />
          </>
        ) : (
          <span className="text-muted-foreground">No changes yet</span>
        )}

        {/* The panel re-reads on the agent's own events, which say nothing
            about edits the user makes by hand. This is the way back from that. */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto -mr-1.5 text-muted-foreground/60 hover:text-muted-foreground"
          onClick={refresh}
          title="Refresh"
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
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

function Empty({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <p
      className={cn(
        "px-3 py-6 text-ui",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono text-ui">
      {added > 0 && <span className="text-emerald-500">+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="text-destructive">−{removed}</span>}
    </span>
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
  const note = (text: string, tone?: "error") => (
    <p
      className={cn(
        "border-t border-border px-3 py-2 text-ui",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {text}
    </p>
  );

  if (error) return note(error, "error");
  if (!versions) return note("Loading…");
  if (versions.unreadable) {
    // Deliberately "not UTF-8" rather than "binary": git's own binary test is
    // NUL-based, so a Latin-1 or UTF-16 file passes it and the row above shows
    // real line counts. Calling that binary contradicts the numbers next to it.
    return note(
      versions.unreadable === "binary"
        ? "Not UTF-8 text — no diff to show."
        : "File is too large to diff here.",
    );
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
