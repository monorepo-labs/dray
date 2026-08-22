import FileIcon from "@/components/FileIcon";
import PickerMenu from "@/components/composer/PickerMenu";
import type { FileMatch } from "@/types/events";

/// The `@` picker's rows. A flat list always: unlike the command picker there is
/// no browse mode to group, because the ranking is the whole answer — an empty
/// query is scored by git status and path depth rather than being an unordered
/// dump, so what a bare `@` opens on is already the useful list.
///
/// The name leads and the directory trails it, dimmed. Two files with the same
/// name are told apart by their directory, but the name is what was typed and
/// what is being looked for, so it gets the weight and the directory gets the
/// truncation.
export default function FileMentionMenu({
  files,
  activeIndex,
  onPick,
  onHover,
  placement = "above",
  bare = false,
}: {
  files: FileMatch[];
  activeIndex: number;
  onPick: (file: FileMatch) => void;
  onHover: (index: number) => void;
  placement?: "above" | "below";
  bare?: boolean;
}) {
  return (
    <PickerMenu
      groups={[{ label: null, items: files }]}
      label="Files"
      keyOf={(file) => file.path}
      activeIndex={activeIndex}
      onPick={onPick}
      onHover={onHover}
      placement={placement}
      bare={bare}
      renderItem={(file) => (
        <>
          {/* The one place in this menu that carries colour, and the reason the
              rows read as files at a glance rather than as another list of
              strings. Same set the changes panel uses. */}
          <FileIcon path={file.path} className="size-3.5" />

          <span className="shrink-0 font-medium">{file.name}</span>

          {/* Empty at the root, where the name alone is the whole path.
              Truncated from the right like every other overflowing string in
              the app: `dir="rtl"` would keep the more informative deep end, but
              it reorders neutral characters at the edges, so it is a bidi bug
              waiting on the first path this app doesn't expect. */}
          {file.dir && <span className="min-w-0 truncate text-muted-foreground">{file.dir}</span>}
        </>
      )}
    />
  );
}
