import type { DirEntry } from "@/types/events";

/// One drawn row: an entry and how deep it sits.
export type TreeRow = { entry: DirEntry; depth: number };

/// The root listing's key. A directory's own `path` is relative to the
/// session's directory, so the root has none.
export const ROOT = "";

/// The expanded tree as a flat list, in drawn order.
///
/// Flat because the keyboard works on a list: ↑/↓ are one step through this
/// array, where a nested render would have to walk a shape the DOM only
/// implies. Directories are recursed into only where they are *both* expanded
/// and listed — a directory whose listing has not landed yet draws its own row
/// and nothing under it, which is the state an expand is in for one frame.
export function flattenTree(
  listings: ReadonlyMap<string, readonly DirEntry[]>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (dir: string, depth: number) => {
    for (const entry of listings.get(dir) ?? []) {
      rows.push({ entry, depth });
      if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
  };

  walk(ROOT, 0);
  return rows;
}

/// Every directory that has to be open for `path` to be on screen, outermost
/// first.
///
/// The path's own prefixes and not the file itself: `src/lib/a.ts` wants `src`
/// and `src/lib` expanded. An empty list for a file at the root, which is the
/// ordinary case and not a failure.
export function expandTo(path: string): string[] {
  const parts = path.split("/").slice(0, -1).filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/// What each open tab is called, in the order it was given.
///
/// The basename alone wherever it is unambiguous, and the parent directory
/// appended where it is not — `index.ts — changes` beside `index.ts — files`.
/// The whole list is judged at once rather than a tab asking about itself,
/// since a name only becomes ambiguous when a second file arrives, and the tab
/// that has to change is the one already on screen.
export function tabLabels(paths: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const name = basename(path);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return paths.map((path) => {
    const name = basename(path);
    if ((counts.get(name) ?? 0) < 2) return name;
    const parent = basename(path.slice(0, path.lastIndexOf("/")));
    // Two files with the same name at the root of two different trees is the
    // one case this cannot separate. The tab's `title` carries the full path,
    // which is where that question gets answered.
    return parent ? `${name} — ${parent}` : name;
  });
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
