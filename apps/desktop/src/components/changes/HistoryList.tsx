import Avatar from "@/components/Avatar";
import FileList from "@/components/changes/FileList";
import { useAvatar } from "@/hooks/useAvatar";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ChangedFile, Commit } from "@/types/events";

/// The branch's commits, newest first, each opening in place to show what it
/// touched.
///
/// In place rather than as a second column or a drill-in. A column would leave
/// the diff the narrowest of three panes, and replacing the list would hide the
/// history behind whichever commit was open. Opening in place keeps both on
/// screen — and it is why **nothing is selected on arrival**: a first commit
/// touching thirty files would push the rest of the history off screen before
/// the reader had picked anything.
///
/// No chevron. The row is the control, its highlight says which is open, and a
/// second click closes it — an arrow would only label what the row already
/// demonstrates.
export default function HistoryList({
  commits,
  selected,
  onToggle,
  files,
  selectedFile,
  onSelectFile,
  hasMore,
  onLoadMore,
  loading,
  error,
}: {
  commits: readonly Commit[];
  /// The open commit, or null when the list is closed up.
  selected: string | null;
  onToggle: (commit: Commit) => void;
  /// The open commit's files. Empty while its read is in flight.
  files: readonly ChangedFile[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  loading: boolean;
  error: string | null;
}) {
  if (error) return <p className="px-3 py-6 text-ui text-destructive">{error}</p>;
  if (!commits.length) {
    return (
      <p className="px-3 py-6 text-ui text-muted-foreground">
        {loading ? "Reading the history…" : "No commits yet."}
      </p>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {commits.map((commit) => {
        const open = commit.sha === selected;

        return (
          <div key={commit.sha}>
            <CommitRow commit={commit} open={open} onToggle={onToggle} />

            {open && (
              <FileList
                files={files}
                selected={selectedFile}
                onSelect={onSelectFile}
                indent
                className="border-y border-border bg-sidebar-accent/20"
              />
            )}
          </div>
        );
      })}

      {/* A row rather than a scroll sentinel: the list is a record being read
          deliberately, and pulling in more of it on scroll makes the end of the
          history impossible to reach. */}
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          className="w-full px-3 py-2 text-left text-ui text-muted-foreground hover:text-foreground"
        >
          Load more
        </button>
      )}
    </div>
  );
}

/// One commit's row: who, what, and when.
///
/// Its own component so the avatar's lookup is scoped to the row that needs it
/// — the hook resolves one address, and a list of thirty would otherwise run
/// thirty effects in the parent.
function CommitRow({
  commit,
  open,
  onToggle,
}: {
  commit: Commit;
  open: boolean;
  onToggle: (commit: Commit) => void;
}) {
  const avatar = useAvatar(commit.authorEmail);

  return (
    <button
      type="button"
      onClick={() => onToggle(commit)}
      className={cn(
        "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-ui",
        open ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50",
      )}
    >
      <span className="w-full truncate text-sidebar-foreground">{commit.subject}</span>
      {/* The picture sits on the byline rather than out at the row's left edge:
          it says *who*, so it belongs next to the name, and a column of faces
          beside the subjects would compete with the subjects for the eye. */}
      <span className="flex w-full items-center gap-1.5 text-muted-foreground">
        <Avatar src={avatar} name={commit.author} className="size-3.5 text-[8px]" />
        <span className="truncate">{commit.author}</span>
        <span>·</span>
        <span className="shrink-0">{relativeTime(commit.authoredAt)}</span>
      </span>
    </button>
  );
}
