import { useState } from "react";

import DiffPane from "@/components/changes/DiffPane";
import FileList from "@/components/changes/FileList";
import HistoryList from "@/components/changes/HistoryList";
import { useChanges } from "@/hooks/useChanges";
import { useCommitLog, useHeadTree } from "@/hooks/useRepo";
import { commitBase } from "@/lib/commit";
import { cn } from "@/lib/utils";
import type { ChangedFile, Commit } from "@/types/events";

const SUB_TABS = [
  // "Uncommitted" rather than "Changes": the view is already called Changes,
  // and a tab repeating its parent's name says nothing about what sets it apart
  // from the tab beside it.
  { value: "uncommitted", label: "Uncommitted" },
  { value: "history", label: "History" },
] as const;

type SubTab = (typeof SUB_TABS)[number]["value"];

/// Holds identity for the two lists' `files` when a read hasn't landed, so the
/// selection below doesn't churn on a fresh array every render.
const NO_FILES: readonly ChangedFile[] = [];

/// The session's repository: what is uncommitted, what has been committed, and
/// the diff for whichever file is selected.
///
/// Read-only, deliberately. The conversation next door is where work gets made
/// and committed — a second place to write commits would be a second way to do
/// the thing the reader is already asking the agent for. The backend keeps
/// `commit_files` and `push_branch` for when a surface for them earns its way
/// back; nothing in the UI calls them today.
///
/// Scoped to the whole tree, unlike the right panel's changes tab, which
/// answers "what did this turn do" and stays as it is. Everything runs against
/// `cwd` rather than the project root — a worktree session has its own tree.
export default function ChangesView({
  cwd,
  active,
  revision,
}: {
  cwd: string;
  /// False while another view is showing. The component stays mounted so its
  /// selection and its rendered diffs survive, but a hidden view must not keep
  /// snapshotting the working tree on every event.
  active: boolean;
  revision: string;
}) {
  const [subTab, setSubTab] = useState<SubTab>("uncommitted");
  const [commit, setCommit] = useState<Commit | null>(null);
  const [workingPath, setWorkingPath] = useState<string | null>(null);
  const [commitPath, setCommitPath] = useState<string | null>(null);

  const head = useHeadTree(cwd, revision, active);
  const log = useCommitLog(cwd, revision, active && subTab === "history");

  // The uncommitted range: HEAD's tree against the working tree as it stands,
  // which `changes_since` snapshots to answer. A commit moves HEAD, so the key
  // rolls onto the new baseline on its own — nothing has to invalidate a cache.
  const working = useChanges(cwd, head.tree, null, revision, active && subTab === "uncommitted");

  // A commit's own range is two fixed ids, so this is read once and cached
  // forever — reopening one costs nothing after the first time.
  const commitChanges = useChanges(
    cwd,
    commit ? commitBase(commit) : null,
    commit?.sha ?? null,
    "",
    active && subTab === "history" && !!commit,
  );

  const workingFiles = working.changes?.files ?? NO_FILES;
  const commitFiles = commitChanges.changes?.files ?? NO_FILES;

  // Derived rather than stored, so a file that stops being changed cannot leave
  // the pane pointing at nothing. First by position when there is no pick: the
  // diff has its own pane here, so opening one hides nothing the way it would
  // in the turn panel's single column.
  const pick = (files: readonly ChangedFile[], path: string | null) =>
    files.find((f) => f.path === path) ?? files[0] ?? null;

  const selectedWorking = pick(workingFiles, workingPath);
  const selectedCommitFile = pick(commitFiles, commitPath);

  const showing = subTab === "uncommitted" ? working : commitChanges;
  const selectedFile = subTab === "uncommitted" ? selectedWorking : selectedCommitFile;

  // A directory that isn't a repository has no HEAD to diff against. Said
  // plainly rather than drawn as an empty change list, which would read as a
  // clean tree.
  if (head.tree === null && !working.changes) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center border-t border-border px-6 text-ui text-muted-foreground">
        This session is not in a git repository.
      </div>
    );
  }

  return (
    // The top border is what parts this from the titlebar. Without it the
    // sub-tab row and the pane's file header float directly under the window's
    // own controls and read as part of them.
    <div className="flex min-h-0 flex-1 border-t border-border">
      <div className="flex w-72 shrink-0 flex-col border-r border-border">
        {/* `px-1` against the right panel's `px-2`, because the tabs here have
            a list under them rather than a panel body: the button's own `px-2`
            lands its label at 12px, level with the filenames below it. */}
        <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-1">
          {SUB_TABS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setSubTab(value)}
              className={cn(
                "rounded-md px-2 py-1 text-ui transition-colors",
                subTab === value
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
              {value === "uncommitted" && workingFiles.length > 0 && (
                <span className="ml-1 text-muted-foreground">{workingFiles.length}</span>
              )}
            </button>
          ))}
        </div>

        {subTab === "uncommitted" ? (
          workingFiles.length === 0 ? (
            <p className="min-h-0 flex-1 px-3 py-6 text-ui text-muted-foreground">
              {working.changes ? "No uncommitted changes." : "Reading the working tree…"}
            </p>
          ) : (
            <FileList
              files={workingFiles}
              selected={selectedWorking?.path ?? null}
              onSelect={setWorkingPath}
              className="min-h-0 flex-1 overflow-y-auto"
            />
          )
        ) : (
          <HistoryList
            commits={log.commits}
            selected={commit?.sha ?? null}
            // Clicking the open commit closes it, which is also the only way
            // back to a list with nothing expanded in it.
            onToggle={(next) => {
              setCommit((prev) => (prev?.sha === next.sha ? null : next));
              setCommitPath(null);
            }}
            files={commitFiles}
            selectedFile={selectedCommitFile?.path ?? null}
            onSelectFile={setCommitPath}
            hasMore={log.hasMore}
            onLoadMore={log.loadMore}
            loading={log.loading}
            error={log.error}
          />
        )}
      </div>

      <DiffPane
        cwd={cwd}
        base={showing.changes?.base ?? ""}
        head={showing.changes?.head ?? ""}
        file={showing.changes ? selectedFile : null}
        empty={
          subTab === "history" && !commit
            ? "Open a commit to see what it changed."
            : "Select a file to see what changed."
        }
      />
    </div>
  );
}
