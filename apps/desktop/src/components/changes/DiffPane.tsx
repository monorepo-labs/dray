import type { CSSProperties } from "react";
import { Columns2, Rows3 } from "lucide-react";

import FileIcon from "@/components/FileIcon";
import IconToggle from "@/components/IconToggle";
import Counts from "@/components/changes/Counts";
import Note, { unreadableText } from "@/components/changes/Note";
import DiffView from "@/components/chat/DiffView";
import { useFileVersions } from "@/hooks/useChanges";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { splitPath } from "@/lib/changes";
import type { ChangedFile } from "@/types/events";

type DiffStyle = "split" | "unified";

/// The library's own spacing, dialled down for a pane rather than a card.
///
/// Both are read from inside its shadow root with these names, and custom
/// properties cross that boundary — so setting them on any ancestor is the
/// whole of the override. `gap-block` is the padding above and below the code:
/// the stock 8px reads as a margin when the diff runs edge to edge, but taking
/// it to nothing presses the first hunk against the file header, so 6px is the
/// gap that parts them without looking like an inset. `gap-style` is the rule
/// between a gutter and its code, and at the stock 2px it draws a channel down
/// the middle of a split view wide enough to look like the two halves are
/// drifting apart.
const DIFF_SPACING = {
  "--diffs-gap-block": "6px",
  "--diffs-gap-style": "1px solid var(--diffs-bg)",
} as CSSProperties;

/// What actually parts the two halves of a split view, and it is not a gap.
///
/// Each column is its own horizontally scrolling box carrying
/// `scrollbar-gutter: stable`, so WebKit reserves a classic scrollbar's width
/// at its **inline end** — even though the library zeroes that scrollbar and
/// only ever measures the horizontal one. The result is a strip of dead
/// background down the right of each column: on the left column it reads as the
/// channel between the two sides, and on the right it reads as the whole diff
/// stopping short of the pane. It is also why the two looked lopsided — the
/// left inset is the library's own spacing, the right one is this.
///
/// `@layer unsafe` is last in the library's own layer order, so this wins
/// without `!important`. Nothing is lost by dropping it: the gutter only ever
/// reserved room for a scrollbar that is drawn at zero width.
const DIFF_CSS = `[data-code] { scrollbar-gutter: auto; }`;

/// The selected file's diff, filling the rest of the view.
///
/// A pane rather than the expanding row the turn panel uses: with a list beside
/// it instead of above it, opening a file costs the reader no scroll position
/// and the diff gets the window's whole height.
export default function DiffPane({
  cwd,
  base,
  head,
  file,
  empty,
}: {
  cwd: string;
  base: string;
  head: string;
  /// Null before anything is picked, and while a list is still loading.
  file: ChangedFile | null;
  /// What to say in that state. The two sub-tabs need different sentences: one
  /// wants a file picked, the other wants a commit opened first.
  empty: string;
}) {
  // Split by default, which is also the library's own default and what anyone
  // arriving from another git client expects. Stored, because it is a way of
  // reading rather than a property of the file being read.
  const [diffStyle, setDiffStyle] = useLocalStorage<DiffStyle>("ade.diffStyle", "split");

  const readable = !!file && !file.binary;
  const { versions, error } = useFileVersions(
    cwd,
    base,
    head,
    // The hook needs a file to key on; `readable` is what stops it fetching.
    file ?? EMPTY_FILE,
    readable,
  );

  if (!file) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-ui text-muted-foreground">
        {empty}
      </div>
    );
  }

  const { dir, name } = splitPath(file.path);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-ui">
        <FileIcon path={file.path} />
        {/* Name first, directory truncating after it — same reason as the list:
            the filename is what has to survive a narrow pane. */}
        <span className="flex min-w-0 flex-1 items-center gap-1.5" title={file.path}>
          <span className="shrink-0 text-sidebar-foreground">{name}</span>
          {dir && (
            <span className="min-w-0 truncate text-muted-foreground">
              {dir.replace(/\/$/, "")}
            </span>
          )}
        </span>

        {file.binary ? (
          <span className="text-muted-foreground">binary</span>
        ) : (
          <Counts added={file.added} removed={file.removed} />
        )}

        <IconToggle value={diffStyle} options={STYLES} onChange={setDiffStyle} tooltips />
      </div>

      {/* No padding: the pane's own border is the frame, and an inset would
          only make the code narrower than the window it was given. */}
      <div className="min-h-0 flex-1 overflow-auto" style={DIFF_SPACING}>
        <Body file={file} versions={versions} error={error} diffStyle={diffStyle} />
      </div>
    </div>
  );
}

/// Keeps `useFileVersions`' key stable when nothing is selected. Never fetched
/// — `enabled` is false in that state — so the path only has to be one no real
/// file collides with.
const EMPTY_FILE: ChangedFile = {
  path: "",
  oldPath: null,
  status: "modified",
  added: 0,
  removed: 0,
  binary: false,
};

const STYLES: { value: DiffStyle; label: string; Icon: typeof Columns2 }[] = [
  { value: "split", label: "Split view", Icon: Columns2 },
  { value: "unified", label: "Unified view", Icon: Rows3 },
];


function Body({
  file,
  versions,
  error,
  diffStyle,
}: {
  file: ChangedFile;
  versions: ReturnType<typeof useFileVersions>["versions"];
  error: string | null;
  diffStyle: DiffStyle;
}) {
  if (file.binary) return <Note text={unreadableText("binary")} />;
  if (error) return <Note text={error} error />;
  if (!versions) return <Note text="Loading…" />;
  if (versions.unreadable) return <Note text={unreadableText(versions.unreadable)} />;

  // A deletion's new side is null, which the viewer reads as an empty file and
  // renders as a full removal; an addition keeps a null old side and draws as
  // new rather than as a diff against nothing.
  return (
    <DiffView
      sides={{ path: file.path, oldText: versions.oldText, newText: versions.newText ?? "" }}
      diffStyle={diffStyle}
      // Split only syncs its two columns' scrolling when lines can overflow, so
      // this travels with it rather than being a taste choice.
      overflow={diffStyle === "split" ? "scroll" : "wrap"}
      unsafeCSS={DIFF_CSS}
      // The stand-in shown while the grammar loads fills the pane rather than
      // sitting as a short box in an empty window.
      fill
      // The pane is the frame, so the diff brings none of its own.
      className="rounded-none border-0"
    />
  );
}
