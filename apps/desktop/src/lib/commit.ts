import type { ChangedFile, Commit } from "@/types/events";

/// Git's empty tree, which every repository has whether anything was ever
/// written into it or not. Stands in as the base for a root commit, so the
/// first commit in a history opens like any other instead of being the one row
/// that cannot be read.
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// What a commit's own diff is taken against.
export function commitBase(commit: Commit): string {
  return commit.parent ?? EMPTY_TREE;
}

/// Which files the reader has turned *off*.
///
/// Unused today: the repo view reads and does not write, so nothing draws a
/// checkbox. Kept with its tests, next to the `commit_files` command it was
/// written for, because the question it answers is the awkward part of any
/// commit surface and re-deriving it later would mean re-learning why the set
/// is inverted.
///
/// Stored inverted — the unchecked set rather than the checked one — so a file
/// the agent writes while the view is open arrives checked, like every other
/// change. Tracking the checked set instead would make each new file default to
/// excluded from the commit, which is the opposite of what a fresh change list
/// means.
export function reconcileUnchecked(
  unchecked: ReadonlySet<string>,
  files: readonly ChangedFile[],
): ReadonlySet<string> {
  const listed = new Set(files.map((f) => f.path));
  // Identity held when nothing was dropped: this runs on every read, and a new
  // Set each time would re-render every row for no change.
  let stale = false;
  for (const path of unchecked) {
    if (!listed.has(path)) {
      stale = true;
      break;
    }
  }
  if (!stale) return unchecked;

  return new Set([...unchecked].filter((path) => listed.has(path)));
}

/// The pathspec for a commit of the checked files.
///
/// A rename contributes **both** names: the new one to add, and the old one so
/// its disappearance is part of the same commit. Leaving the old side out
/// commits the copy and leaves the delete behind as a dirty file.
export function commitPaths(
  files: readonly ChangedFile[],
  unchecked: ReadonlySet<string>,
): string[] {
  const paths: string[] = [];
  for (const file of files) {
    if (unchecked.has(file.path)) continue;
    paths.push(file.path);
    if (file.oldPath) paths.push(file.oldPath);
  }
  return paths;
}

/// How many files a commit would carry, for the button's own label.
export function checkedCount(
  files: readonly ChangedFile[],
  unchecked: ReadonlySet<string>,
): number {
  return files.reduce((n, file) => (unchecked.has(file.path) ? n : n + 1), 0);
}

/// Folds a freshly read first page into the list already on screen.
///
/// The tip is the whole test. While a turn runs this refetches on every event,
/// and replacing the array each time would throw away however far the reader
/// had paged — so an unchanged tip keeps what is there, and a moved one starts
/// again, because everything below it may have moved with a rebase or an amend.
export function reconcileLog(
  prev: readonly Commit[],
  firstPage: readonly Commit[],
): readonly Commit[] {
  if (prev.length === 0) return firstPage;
  if (firstPage.length > 0 && firstPage[0].sha === prev[0].sha) return prev;
  return firstPage;
}

/// Which list the repo view's sub-tab row is showing.
///
/// Named here rather than beside the row it labels, so the rule below can
/// answer in it without this file reaching up into a component.
export type SubTab = "uncommitted" | "branch" | "history";

/// Where that row lands before the reader has picked a tab.
///
/// Uncommitted leads, because it is the one list still being written and every
/// other tab is a record. A clean tree makes it the emptiest thing on screen
/// though, so with nothing to commit the branch's own commits are what the
/// session has to show for itself and the view opens on those instead.
///
/// `settled` is what stops that from flipping under the reader. The view
/// paints before the first read lands, and until it does an empty list says
/// "not asked yet" rather than "nothing changed" — the same two meanings
/// `useHeadTree` carries its own `settled` to tell apart. Read as clean, an
/// unanswered read opens the branch tab for a frame and steps off it the moment
/// the working tree replies.
export function defaultSubTab({
  hasUncommitted,
  settled,
  hasBranchCommits,
}: {
  hasUncommitted: boolean;
  /// Whether the working-tree read has ever come back for this directory.
  settled: boolean;
  hasBranchCommits: boolean;
}): SubTab {
  return !hasUncommitted && settled && hasBranchCommits ? "branch" : "uncommitted";
}
