import PickerMenu from "@/components/composer/PickerMenu";
import type { SessionIndexItem } from "@/types/events";

/// The `&` picker's rows.
///
/// Flat, like the file and issue pickers: the ranking *is* the answer — this
/// project's sessions, most recently touched first — so there is nothing a
/// heading would separate.
///
/// **The title is the whole row.** Every other picker leads with an icon
/// carrying a fact the name doesn't — a file's type, an issue's state — where a
/// session's title is already the only thing anybody tells two of them apart
/// by. A status mark was tried on both edges and taken off: it draws for a
/// working or unread session and nothing else, so it is absent from most rows,
/// and what the reader is doing here is naming a session rather than checking
/// on one. The sidebar is where that question is asked and answered.
export default function SessionMentionMenu({
  sessions,
  activeIndex,
  onPick,
  onHover,
  emptyNote,
  placement = "above",
  bare = false,
}: {
  sessions: SessionIndexItem[];
  /// Drawn where this project holds no other task. A query matching nothing
  /// leaves it unset and the picker simply closes, the reading the `#` and `@`
  /// pickers take of the same case.
  emptyNote?: string;
  activeIndex: number;
  onPick: (session: SessionIndexItem) => void;
  onHover: (index: number) => void;
  placement?: "above" | "below";
  bare?: boolean;
}) {
  return (
    <PickerMenu
      groups={[{ label: null, items: sessions }]}
      // What a screen reader announces, so it takes the reader's word rather
      // than the index's: this app says task everywhere it speaks out loud.
      label="Tasks"
      keyOf={(session) => session.sessionId}
      activeIndex={activeIndex}
      onPick={onPick}
      onHover={onHover}
      placement={placement}
      bare={bare}
      emptyNote={emptyNote}
      renderItem={(session) => <span className="min-w-0 truncate">{session.title}</span>}
    />
  );
}
