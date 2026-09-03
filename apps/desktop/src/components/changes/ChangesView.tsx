import { useState } from "react";

import CommitMessage from "@/components/changes/CommitMessage";
import DiffPane from "@/components/changes/DiffPane";
import FileList from "@/components/changes/FileList";
import HistoryList from "@/components/changes/HistoryList";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChanges } from "@/hooks/useChanges";
import { useHotkey } from "@/hooks/useHotkey";
import { useCommitLog, useHeadTree } from "@/hooks/useRepo";
import { commitBase, defaultSubTab, type SubTab } from "@/lib/commit";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { ChangedFile, Commit } from "@/types/events";

const SUB_TABS = [
  // "Uncommitted" rather than "Changes": the view is already called Changes,
  // and a tab repeating its parent's name says nothing about what sets it apart
  // from the tab beside it.
  { value: "uncommitted", label: "Uncommitted" },
  // Between the two, because it is between them in what it answers: this
  // branch's own commits are narrower than the whole of HEAD's history and
  // wider than what has not been committed yet.
  { value: "branch", label: "Branch" },
  { value: "history", label: "History" },
] as const satisfies readonly { value: SubTab; label: string }[];

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
  // `null` is "the reader never picked", the rule `panelTab` reads by: a hand
  // pick wins from there on, and until there is one the derived default stands.
  // Storing `"uncommitted"` as the initial value would make a fresh arrival
  // indistinguishable from a reader who chose it, so nothing else could ever
  // lead.
  const [subTabPick, setSubTabPick] = useState<SubTab | null>(null);
  const [commit, setCommit] = useState<Commit | null>(null);
  const [branchSha, setBranchSha] = useState<string | null>(null);
  const [workingPath, setWorkingPath] = useState<string | null>(null);
  // A path each, not one shared between the two commit tabs. Switching tabs by
  // the row moves the open commit without either list's `onToggle` running, so
  // a single path followed the reader across and opened a file of the same name
  // in the other tab's commit — which is the auto-selection rule quietly not
  // happening.
  const [commitPath, setCommitPath] = useState<string | null>(null);
  const [branchPath, setBranchPath] = useState<string | null>(null);

  const head = useHeadTree(cwd, revision, active);

  // Both run on `active` alone rather than on the tab they belong to, because
  // the default below reads them both: gating them on the tab they choose is
  // circular, and it flipped the row twice on arrival before it settled. It
  // also makes the Uncommitted count honest from every tab, which it was not
  // before — the read behind it only ran while its own tab was showing. The
  // `active` gate stays on all three reads either way: a hidden view must still
  // not snapshot the working tree on every event.
  //
  // The uncommitted range is HEAD's tree against the working tree as it stands,
  // which `changes_since` snapshots to answer. A commit moves HEAD, so the key
  // rolls onto the new baseline on its own — nothing has to invalidate a cache.
  const working = useChanges(cwd, head.tree, null, revision, active);
  const branchLog = useCommitLog(cwd, revision, active, "log_branch_commits");

  const workingFiles = working.changes?.files ?? NO_FILES;

  const derived = defaultSubTab({
    hasUncommitted: workingFiles.length > 0,
    settled: !!working.changes,
    hasBranchCommits: branchLog.commits.length > 0,
  });

  // Taken **once**, when both reads have first answered, and held from there.
  // The rule picks where the row opens, not where it lives: left deriving on
  // every render it moves under the reader whenever the answer changes — the
  // agent writing a file mid-turn would step them off the diff they were
  // reading and onto Uncommitted. Both reads have to have landed before it can
  // be taken at all, or whichever answers first decides on the other's behalf.
  if (subTabPick === null && working.changes && branchLog.settled) setSubTabPick(derived);

  const subTab = subTabPick ?? derived;

  // A different directory is a different repository, so the tab taken for the
  // old one says nothing about this one.
  const [seeded, setSeeded] = useState(cwd);
  if (seeded !== cwd) {
    setSeeded(cwd);
    setSubTabPick(null);
  }

  // History keeps its gate. It is the expensive read — the whole of HEAD's
  // history behind it, however long that is — and nothing in the rule above
  // asks it anything.
  const log = useCommitLog(cwd, revision, active && subTab === "history", "log_commits");

  // Derived from a sha the way `pick` derives the file below, so a commit that
  // pages out from under the list cannot leave the pane pointing at nothing.
  // Falling back to the newest is what opens this tab on a diff rather than on
  // an empty frame.
  const branchCommit =
    branchLog.commits.find((c) => c.sha === branchSha) ?? branchLog.commits[0] ?? null;

  // One commit is open in the pane at a time, whichever tab opened it, so its
  // read and its file selection are shared rather than written out twice.
  const openCommit = subTab === "branch" ? branchCommit : subTab === "history" ? commit : null;

  // A commit's own range is two fixed ids, so this is read once and cached
  // forever — reopening one costs nothing after the first time.
  const commitChanges = useChanges(
    cwd,
    openCommit ? commitBase(openCommit) : null,
    openCommit?.sha ?? null,
    "",
    active && !!openCommit,
  );

  const commitFiles = commitChanges.changes?.files ?? NO_FILES;

  // Derived rather than stored, so a file that stops being changed cannot leave
  // the pane pointing at nothing. First by position when there is no pick: the
  // diff has its own pane here, so opening one hides nothing the way it would
  // in the turn panel's single column.
  const pick = (files: readonly ChangedFile[], path: string | null) =>
    files.find((f) => f.path === path) ?? files[0] ?? null;

  const selectedWorking = pick(workingFiles, workingPath);
  const selectedCommitFile = pick(commitFiles, subTab === "branch" ? branchPath : commitPath);

  const showing = subTab === "uncommitted" ? working : commitChanges;
  const selectedFile = subTab === "uncommitted" ? selectedWorking : selectedCommitFile;

  // ⌘⇧← / ⌘⇧→ step this row, the same shape ⌘⇧↑/↓ steps the session list — the
  // arrow points at the tab, so a fourth sub-tab would need no fourth binding.
  // Not ⌘1/⌘2, which the view row above already spends, and not ⌘⇧[ /], which
  // belongs to the right panel and would mean two different rows at once.
  //
  // Clamped rather than wrapped: wrapping would make ← from the first tab land
  // on the last, which is the long way round a row this short.
  //
  // Registered only while this view is showing. It stays mounted when it isn't,
  // and `useHotkey` claims every chord it matches, so leaving it bound would
  // take ⌘⇧← from the composer, where it selects to the start of the line.
  const stepSubTab = (delta: number) => {
    const next = SUB_TABS[SUB_TABS.findIndex((t) => t.value === subTab) + delta];
    if (next) setSubTabPick(next.value);
  };
  useHotkey("ArrowLeft", () => stepSubTab(-1), { shift: true, enabled: active });
  useHotkey("ArrowRight", () => stepSubTab(1), { shift: true, enabled: active });

  // A directory that isn't a repository has nothing to diff. Said plainly
  // rather than drawn as an empty change list, which would read as a clean
  // tree — but only once the read has actually answered. Before that `null` is
  // just "not asked yet", and this view paints before the first read lands, so
  // testing the id alone announced every real repository as a plain directory
  // for a frame or two. A repository with no commit yet is not this case: it
  // answers with the empty tree, so its files list as additions.
  if (head.settled && head.tree === null && !working.changes) {
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
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setSubTabPick(value)}
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
              </TooltipTrigger>
              {/* Keycaps alone, like the view row above: the name is already on
                  the button, and one chord steps the row.

                  The same cap on every tab, deliberately. Narrowing it to the
                  reachable direction per tab made a row of three say three
                  different things about one binding, so a reader hovering two
                  tabs had to work out they were the same shortcut. It names the
                  chord, not the trip from the tab under the cursor. */}
              <TooltipContent side="bottom" className="px-1.5">
                <KbdGroup>
                  <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
                  {/* Spelled out, the sidebar's rule: ⇧ is an arrow, and this
                      cap ends in arrow keys, so the glyph reads as a third one.
                      */}
                  <Kbd>Shift</Kbd>
                  <Kbd>←→</Kbd>
                </KbdGroup>
              </TooltipContent>
            </Tooltip>
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
        ) : subTab === "branch" ? (
          <HistoryList
            commits={branchLog.commits}
            selected={branchCommit?.sha ?? null}
            // No closing here, unlike History. Something is always open on this
            // tab, because closing it is exactly the empty pane the tab exists
            // to replace.
            onToggle={(next) => {
              setBranchSha(next.sha);
              setBranchPath(null);
            }}
            files={commitFiles}
            selectedFile={selectedCommitFile?.path ?? null}
            onSelectFile={setBranchPath}
            hasMore={branchLog.hasMore}
            onLoadMore={branchLog.loadMore}
            loading={branchLog.loading}
            error={branchLog.error}
            empty="This branch has no commits of its own yet."
          />
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

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Keyed on the sha so opening another commit arrives collapsed: the
            expanded state belongs to the message being read, not to the pane.
            The message belongs to whichever commit is open, whichever of the
            two tabs opened it. */}
        {openCommit && <CommitMessage key={openCommit.sha} commit={openCommit} />}

        <DiffPane
          cwd={cwd}
          base={showing.changes?.base ?? ""}
          head={showing.changes?.head ?? ""}
          file={showing.changes ? selectedFile : null}
          empty={
            subTab === "history" && !commit
              ? "Open a commit to see what it changed."
              : subTab === "branch" && !branchCommit
                ? "This branch has no commits of its own yet."
                : "Select a file to see what changed."
          }
        />
      </div>
    </div>
  );
}
