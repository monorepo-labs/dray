import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { ChangedFile, ChangeSet, FileVersions } from "@/types/events";

/// How many change sets to keep. Small on purpose: one entry per baseline is
/// one per turn-with-the-panel-open, and the newest few cover reopening.
const CHANGE_SET_LIMIT = 12;

/// File contents are budgeted by size, not by count. A count cap was the bug:
/// capped at 12 entries, any turn touching more files than that evicted its own
/// rows while they mounted, so every reopen refetched everything — the cache
/// looked absent exactly when it mattered most. Sides are capped at 1MB each in
/// Rust, so this holds at least a dozen worst-case files and hundreds of
/// ordinary ones.
const FILE_BYTES_BUDGET = 32 << 20;

/// Survives the panel unmounting, which is the whole point — closing and
/// reopening used to re-read the working tree and re-fetch every file, so a
/// two-file diff spent half a second redrawing something it already had.
///
/// The two are not equally safe, and the difference decides how each is used.
///
/// `fileVersions` is keyed by the **snapshot** its contents came from, so an
/// entry genuinely cannot go stale — a new snapshot is a new key — and it is
/// read as authoritative, fetched once and never refetched.
///
/// `changeSets` is keyed by the **range**. A finished turn's key names two
/// fixed trees, so that entry is as immutable as a file version and is read as
/// final. A running turn's key ends in `live` instead: the same key means a
/// different answer a second later, so it is a *seed* — what to paint
/// immediately on open, always followed by a fresh read — never an authority.
/// That is also why only the newest request may write to it, below.
///
/// Eviction is a size cap in both cases rather than invalidation.
const changeSets = new Map<string, ChangeSet>();
const fileVersions = new Map<string, FileVersions>();

function rememberChangeSet(key: string, value: ChangeSet) {
  // Re-inserting moves the key to the end, so iteration order is least- to
  // most-recently written and the first key is the one to drop.
  changeSets.delete(key);
  changeSets.set(key, value);
  while (changeSets.size > CHANGE_SET_LIMIT) {
    const oldest = changeSets.keys().next().value;
    if (oldest === undefined) break;
    changeSets.delete(oldest);
  }
}

const sizeOf = (v: FileVersions) =>
  (v.oldText?.length ?? 0) + (v.newText?.length ?? 0) + 1;

let fileBytes = 0;

function rememberFileVersions(key: string, value: FileVersions) {
  const prev = fileVersions.get(key);
  if (prev) {
    fileBytes -= sizeOf(prev);
    fileVersions.delete(key);
  }
  fileVersions.set(key, value);
  fileBytes += sizeOf(value);
  // `> 1` so a single over-budget entry is kept rather than evicted the moment
  // it lands — half a cache beats none.
  while (fileBytes > FILE_BYTES_BUDGET && fileVersions.size > 1) {
    const oldest = fileVersions.keys().next().value;
    if (oldest === undefined) break;
    fileBytes -= sizeOf(fileVersions.get(oldest)!);
    fileVersions.delete(oldest);
  }
}

/// A turn's worth of events arrives in bursts, and each would otherwise cost a
/// full working-tree snapshot. Only *refreshes* wait this out — the first read
/// of a baseline is immediate, since there is nothing on screen to keep.
const REFRESH_DEBOUNCE = 300;

export type ChangesState = {
  changes: ChangeSet | null;
  error: string | null;
  /// A read is in flight. Never blanks the view: the previous result stays up
  /// while the next one is fetched, so a refresh reads as a refresh and not as
  /// the panel starting over.
  loading: boolean;
  refresh: () => void;
};

/// The diff for a turn's range, cached across mounts.
///
/// `head` frozen (a finished turn) is the strong case: two fixed trees diff to
/// one immutable answer, so the cache is authoritative and nothing re-reads
/// it. `head` null (a turn still running) diffs against the moving working
/// tree, re-read on `revision` behind the debounce.
export function useChanges(
  cwd: string,
  baseline: string | null,
  /// The turn's closing snapshot, or null to diff against the tree as it
  /// stands now.
  head: string | null,
  /// Changes whenever the agent may have written something.
  revision: string,
  /// False while the panel is hidden. The component stays mounted so its state
  /// and DOM survive, but a hidden panel must not keep snapshotting the working
  /// tree on every event — reads resume when it comes back on screen.
  active: boolean,
): ChangesState {
  // `\0` as the separator: it is the one byte a path cannot contain, so no
  // (cwd, baseline, head) triple can collide with another. The escape, never a
  // literal NUL byte — a raw NUL makes git call the whole file binary.
  const key = baseline ? `${cwd}\0${baseline}\0${head ?? "live"}` : null;

  const [changes, setChanges] = useState<ChangeSet | null>(
    () => (key && changeSets.get(key)) || null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Re-seed synchronously when the range changes, rather than in an effect: an
  // effect would paint one frame of the *previous* turn's files under the new
  // turn's heading before correcting itself.
  const [seeded, setSeeded] = useState(key);
  if (seeded !== key) {
    setSeeded(key);
    // A key change on the *same* baseline is the turn's own head freezing
    // (live → finished), not a new turn — the rows on screen are the right
    // rows, so they stand as the seed while the frozen read lands. Blanking
    // here made every turn's end flash "Reading the working tree…".
    setChanges((prev) => {
      const cached = key ? changeSets.get(key) : null;
      return cached ?? (baseline && prev && prev.base === baseline ? prev : null);
    });
    setError(null);
    // A read still running belongs to the old range and will be discarded by
    // the counter, so its spinner has to go with it.
    setLoading(false);
  }

  // Only the newest request may commit anything — state, cache, or the spinner.
  //
  // A key-change guard is not enough: two reads for the *same* key can overlap
  // (a slow one crossing the next debounced one, or a manual refresh), and the
  // last to *arrive* is not the last to have *snapshotted*. Without a counter an
  // older working-tree reading can overwrite a newer one and then sit in the
  // cache until something else triggers a refresh.
  const issued = useRef(0);
  const inFlight = useRef(false);

  const read = useCallback(async () => {
    if (!key || !baseline) return;

    const token = ++issued.current;
    inFlight.current = true;
    setLoading(true);
    try {
      const next = await invoke<ChangeSet>("changes_since", { cwd, baseline, head });
      if (issued.current !== token) return;
      // Cached inside the guard, not before it: a live key's value moves under
      // a stable key, so a stale write would persist there.
      rememberChangeSet(key, next);
      // The diff is a pure function of the two trees, so matching ids mean an
      // identical answer — keep the old object and every row's props hold
      // still. Without this each debounced refresh during a turn re-rendered
      // every diff to display the same thing.
      setChanges((prev) =>
        prev && prev.base === next.base && prev.head === next.head ? prev : next,
      );
      setError(null);
    } catch (e) {
      if (issued.current === token) setError(String(e));
    } finally {
      if (issued.current === token) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [cwd, baseline, head, key]);

  useEffect(() => {
    if (!key || !active) return;

    // Nothing on screen and nothing already fetching: read now, since waiting
    // buys nothing. The `inFlight` half matters — without it, every revision
    // bump during that first read starts another one immediately, which is a
    // burst of concurrent `git add -A` snapshots slipping through the very
    // debounce that exists to prevent them.
    if (!changeSets.has(key) && !inFlight.current) {
      void read();
      return;
    }

    // A frozen range is immutable, so a cached answer is final — revision
    // bumps and reopens have nothing to add. Manual refresh still works.
    if (head) return;

    // `active` in the deps is what refreshes on reopen: events that landed
    // while the panel was hidden bumped `revision` with this effect off, so
    // coming back on screen has to count as a reason to re-read.
    const timer = setTimeout(() => void read(), REFRESH_DEBOUNCE);
    return () => clearTimeout(timer);
  }, [key, read, revision, active, head]);

  return { changes, error, loading, refresh: read };
}

/// Same `\0` separator as `useChanges`' key, for the same reason.
const fileKey = (head: string, path: string) => `${head}\0${path}`;

/// One file's two sides, cached against the snapshot they were read from.
export function useFileVersions(
  cwd: string,
  base: string,
  head: string,
  file: ChangedFile,
  /// Skipped while the row is collapsed, and for a binary file, which has no
  /// diff to fetch.
  enabled: boolean,
): { versions: FileVersions | null; error: string | null } {
  const key = fileKey(head, file.path);

  const [versions, setVersions] = useState<FileVersions | null>(
    () => fileVersions.get(key) ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  const [seeded, setSeeded] = useState(key);
  if (seeded !== key) {
    setSeeded(key);
    setVersions(fileVersions.get(key) ?? null);
    setError(null);
  }

  useEffect(() => {
    if (!enabled) return;

    // Adopted here rather than only on a key change: closing a row before its
    // read lands tears down `live`, so the value reaches the map but not the
    // state — and on reopen the fetch below is skipped for a cached key.
    // Without this, that row sits on "Loading…" forever.
    const cached = fileVersions.get(key);
    if (cached) {
      setVersions(cached);
      return;
    }

    let live = true;
    invoke<FileVersions>("file_change", {
      cwd,
      base,
      head,
      path: file.path,
      oldPath: file.oldPath,
    })
      .then((next) => {
        rememberFileVersions(key, next);
        if (live) setVersions(next);
      })
      .catch((e) => live && setError(String(e)));

    return () => {
      live = false;
    };
  }, [enabled, key, cwd, base, head, file.path, file.oldPath]);

  return { versions, error };
}
