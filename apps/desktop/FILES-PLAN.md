# The Files view

A read-only file viewer as a fourth main-column tab: Chat, Diff, Browser,
**Files**. A tree on one side, a tab strip and code pane on the other, the tree
movable to the right and resizable, both remembered in local storage.

Written against `main` at `664c586f`. Decisions taken with the reader on
2026-09-15: folder tree plus a filter box; editor-style tab strip; chat links
open code here and markdown still in Docs; ignored files shown dimmed the way
VS Code draws them; the side switch is a button in the list header; the list
width is a drag handle.

## What already exists and is reused

| need | already here |
|---|---|
| syntax highlighting | `File` from `@pierre/diffs`, the way [CodeView](src/components/chat/CodeView.tsx) uses it — shared Shiki, worker pool, theme pair from `useCodeThemeWithMode`, `useHighlighter` gate |
| plain text over a size | the library's own `tokenizeMaxLength` (default 100KB) falls back to plain text; nothing to write |
| fuzzy filter | `useFileSearch` + `search_files` over the fff index the `@` picker already builds and watches |
| file icons | `FileIcon` (vscode-material-icons) |
| reading a text file safely | `docs::read_doc`'s shape: metadata first, capped read, UTF-8 refusal |
| re-reading on change | `watch_docs` + `doc_changed`, generalised to a keyed watcher (below) |
| open-from-a-link signal | `useDocs`'s `opened` counter, mirrored |
| "Open in editor" | `openFile` in [openWith.ts](src/lib/openWith.ts), line-aware |
| list width and side | `useLocalStorage` |
| tab stepping | `subtab.prev` / `subtab.next`, gated on `active` like the Diff view |
| side-by-side layout, title border, list styling | `ChangesView` and `FileList` are the pattern to copy |

New dependency: none. `ignore` is in `Cargo.lock` via fff but is not needed —
`git check-ignore` answers nested ignores, excludes and the global ignore in
one spawn, which the crate's single-file matcher does not.

## Backend

Two commands in [files.rs](src-tauri/src/files.rs), one generalisation in
[docs.rs](src-tauri/src/docs.rs).

**`list_dir(cwd, dir) -> Vec<DirEntry>`** — `dir` relative to `cwd`, `""` for
the root. `std::fs::read_dir`, sorted directories first then case-insensitive by
name, which is VS Code's order. `.git`, `.svn`, `.hg`, `.DS_Store` and
`Thumbs.db` dropped: VS Code's `files.exclude` defaults, and nothing else —
`node_modules` and `target` list like any directory. `ignored` per entry from
one `git check-ignore --stdin -z` over the listing, `false` for all where the
directory is no repository or git fails. Symlinks report `isDir` off the
target so a linked directory expands; a broken link lists as a file.

```rust
#[serde(rename_all = "camelCase")]
pub struct DirEntry { pub name: String, pub path: String, pub is_dir: bool, pub ignored: bool }
```

**`read_file(path) -> FileBody`** — `Text { text }`, `Image { data_url }`, or
`Err(String)` naming why. Text takes `read_doc`'s three checks with the cap at
**4MB** rather than the doc panel's 1MB: a lockfile is the file most likely
opened here and the renderer already goes plain past 100KB, so the cost of a big
file is scrolling, not freezing. Images (png/jpeg/gif/webp/svg, `attachments.rs`'s
own mime table, under its `MAX_IMAGE_BYTES`) come back as a `data:` URL — the
asset protocol is scoped to the attachments directory and must stay so. Anything
else non-UTF-8 is "Not text — nothing to show." No `unknown` field, since this
never goes to disk.

**`watch_docs` takes a `scope`** and `WATCH` becomes `HashMap<String,
RecommendedWatcher>`. The Docs panel passes `"docs"`, the Files view `"files"`;
each replaces its own watcher and the `doc_changed` event is unchanged, each
listener already filtering on its own open set. Without this the two panels
would silently take each other's watch away on every open.

Tests: `list_dir` sort and exclusion on a tempdir; `read_file` cap and image
branch; `watch_docs` two scopes coexisting.

## Frontend

### View tab

`VIEW_TABS` gains `"files"` (label Files, chord `view.files` = ⌘⌥4) — the row's
own docs say a fourth view is one array entry, one body, one shortcut id.
`App.tsx`: one `useHotkey`, one `TabBody` mounting `FilesView` keyed by session
id like `ChangesView`, `active={viewTab === "files"}`.

### State: `useOpenFiles` ([src/hooks/useOpenFiles.ts](src/hooks/useOpenFiles.ts))

Module store keyed by session, `useSyncExternalStore`d, the shape of
`useDocs` without the draft half:

```ts
type OpenFile = { path: string; line?: number };      // path absolute
type SessionFiles = { open: OpenFile[]; active: string | null };
```

`openInFiles(sid, path, line?)` appends or activates and bumps an `opened`
counter; `closeFile`, `activateFile`. The counter is what `App` effects on to
flip `viewTab` to `"files"` — a link click lands several components below
anything holding that state, the same gap `useDocs` names. Per session because
a link in one transcript must not open a tab in every other session's view.
In memory only, lost on restart, like `viewTabs`.

Tree state (expanded set, listed entries, filter text) lives in `FilesView`,
which is keyed by session so it resets per session and survives tab switches.

### Layout: `FilesView` ([src/components/files/FilesView.tsx](src/components/files/FilesView.tsx))

```
┌─ tree ──────┬─ tabs: a.ts × │ b.rs × ──────────────┐
│ [filter] ⇄  │ path/to/a.ts                 Open in ↗│
│ ▸ src       │ 1  import …                           │
│ ▾ src-tauri │ 2  …                                  │
│   · lib.rs  │                                       │
└─────────────┴───────────────────────────────────────┘
```

- `flex` with `flex-row-reverse` when `ade.filesListSide === "right"`; the
  border moves with it (`border-r` / `border-l`). Default left.
- Width from `ade.filesListWidth`, default 288 (the Diff view's `w-72`),
  clamped 180–640. The handle is a 4px strip on the list's inner edge with
  `cursor-col-resize`, `setPointerCapture` on pointerdown, width written on
  pointerup only — writing on every move would put a JSON stringify on each
  frame for nothing. Double-click resets to default. No handle exists in the
  app today; this is the first, and it stays inside this component until a
  second surface wants one.
- The side switch is one icon button (`PanelLeft`/`PanelRight`) beside the
  filter box, tooltip "Move list to the right" / "…left". Local storage,
  read through `useLocalStorage` in this one component — nothing else reads
  the key.
- Empty pane: "Pick a file to read it." Same border-top-from-titlebar rule
  the Diff view states.

### Tree: `FileTree` ([src/components/files/FileTree.tsx](src/components/files/FileTree.tsx))

- Root listed on mount and whenever `active` turns true or `revision` moves
  (turn end) — every *expanded* directory is relisted then, one `list_dir`
  each. That is the tree keeping up with the agent's writes; nothing polls.
- Expand = `list_dir` for that directory, cached in a `Map<dir, DirEntry[]>`
  until the next relist. Collapsing keeps the entries so re-expanding is
  instant.
- Rows are the expanded set **flattened** (`flattenTree` in
  [src/lib/fileTree.ts](src/lib/fileTree.ts), pure and tested) so keyboard
  works on a list: ↑/↓ move, → expands or steps in, ← collapses or steps to
  the parent, Enter opens. Indent = depth × 12px. Not virtualised;
  `ponytail:` a repo with thousands of rows expanded at once is the reader's
  own doing, and the Diff view's list draws the same way.
- Ignored entries draw `text-muted-foreground`, VS Code's grey. Directories
  carry a chevron and no `FileIcon`; files carry `FileIcon`.
- Single click opens (activates the tab if open). No preview-tab italics.
- The row for the active file is highlighted, and opening from a link or the
  filter expands the tree to it (`expandTo(path)` — split on `/`, add each
  prefix to the set, list any not cached).

**Filter**: a text box at the top. Non-empty replaces the tree with
`useFileSearch(cwd, query)`'s rows drawn as `dir/name` the `@` picker's way;
↑/↓/Enter the same; Escape clears and returns focus to the tree. Empty query
draws the tree, not the ranked list — the tree is what an empty box means
here. The hook already debounces and already warms the index on `cwd`.

### Tabs: `FileTabs` ([src/components/files/FileTabs.tsx](src/components/files/FileTabs.tsx))

`TabButton` rows across the top of the pane, `FileIcon` + basename, an `×` on
hover and always on the active one, middle-click closes. Two tabs with the
same basename get their parent directory appended (`index.ts — changes`,
`index.ts — files`), computed in `tabLabels` in `fileTree.ts` and tested.
Closing the active tab activates the neighbour on the left, or the right at
the start — VS Code's rule. ⌘⇧←/→ step through `subtab.prev`/`subtab.next`,
bound only while the view is active, `skipInTextField` for the filter box.
No close chord: ⌘W is the window's and ⌘⌥W is `pane.close`; the button and
middle-click cover it until a chord is asked for. Overflow scrolls
horizontally with the wheel; no dropdown.

### Viewer: `FileViewer` ([src/components/files/FileViewer.tsx](src/components/files/FileViewer.tsx))

- Header row: `FileIcon`, path relative to `cwd` (absolute when outside it,
  tail-truncated with `direction: rtl` like `FileList`), and an "Open in"
  button calling `openFile(path, line)` — the external editor, the one write
  path this view has and it is not a write.
- Body: `File` with `disableFileHeader`, `overflow: "scroll"`, full height,
  the library's own gutter. Reads through `read_file` on activation, held per
  path in the store so switching tabs is a re-render and not a re-read.
  Re-read on `doc_changed` for an open path, on `revision` moving, and on the
  header's refresh — the same three the Docs panel answers to.
- `useHighlighter` gate, plain `<pre>` meanwhile, exactly as `CodeView`.
- **Line from a link**: `onPostRender` finds `[data-line-index="line-1"]` in
  the host's shadow root, `scrollIntoView({ block: "center" })` once, and sets
  `data-target` on the row; `unsafeCSS` paints `[data-target] { background:
  var(--diffs-line-target) }` — the same route `DiffPane` takes for its own
  overrides. Cleared on the next open of that tab. A line past the end
  highlights nothing.
- Image body: `<img>` centred, checkerboard behind it, natural size capped to
  the pane. Error body: the sentence, centred, muted.
- Large files: nothing special — the library goes plain at 100KB and the
  4MB cap lands as a sentence.

### Chat links

`openPath` in `useDocs.ts`: markdown → `openDoc` as today; everything else →
`openInFiles(sid, path, line)`. `FileLink` passes the modifier: ⌘-click (Ctrl
elsewhere) goes to `openFile` — the external editor — for both kinds, matching
the "out there, not here" meaning ⌘-click already has on issue rows and links.
The comment on `FileLink` saying "everything else in the reader's editor" is
rewritten, since it becomes false.

`ChangesView`'s file rows are left alone: a diff and a file are different
answers and the Diff view already has its own pane.

## Shortcuts

| id | chord | where |
|---|---|---|
| `view.files` | ⌘⌥4 | registry, new |
| `subtab.prev` / `subtab.next` | ⌘⇧← / → | reused, gated on the view |

Nothing else. A quick-open chord (⌘P is free; ⌘⇧P is the project picker) is
one line later if the filter box wants a key — skipped until asked.

## Order of work

1. Rust: `list_dir`, `read_file`, keyed `watch_docs`; tests; bare `cargo test`
   to regenerate `events.ts`.
2. `useOpenFiles` store; `fileTree.ts` (`flattenTree`, `tabLabels`,
   `expandTo`) with tests.
3. `FilesView` + `FileTree` + `FileTabs` + `FileViewer`; `VIEW_TABS`,
   shortcut id, `App.tsx` body and hotkey.
4. Chat links: `openPath` branch, `FileLink` modifier.
5. Side switch and drag handle, local storage.
6. CLAUDE.md section "The files view" beside "The repo view"; COPY nothing —
   no tracker strings here.

One PR, draft, Codex reviewer, then ready — real change spanning both sides.
Linear issue to create at the first edit: **"Files view: read-only file tree
and viewer as a fourth main tab"**.

## Not in this

- **Search inside a file** — the code sits in a shadow root, so ⌘F finds
  nothing there; a find bar is its own piece of work.
- **Editing.** The Docs panel edits markdown because a doc is the reader's;
  code is the agent's, and the view's whole promise is that it changes
  nothing.
- **Go to definition, symbols, minimap** — an IDE's, not a viewer's.
- **Virtualised tree**, **persisted open tabs**, **close chord**, **quick-open
  chord** — each one small, each waiting for someone to miss it.
- **Files outside `cwd` in the tree.** A link can open one (absolute path,
  tab labelled absolute); the tree stays rooted at the session's directory.
