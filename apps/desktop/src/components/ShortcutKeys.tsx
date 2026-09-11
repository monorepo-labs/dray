import { Fragment } from "react";

import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useShortcutOverrides, chordFor } from "@/hooks/useShortcuts";
import { formatChords, type ShortcutId } from "@/lib/shortcuts";

/// The caps for one or more shortcuts, read off the same store `useHotkey`
/// binds from — so a tooltip can never name a chord the key no longer fires.
///
/// Several ids draw as one hint where they share modifiers (`⌘ Shift ↑↓`),
/// which is how the sidebar and the tab rows have always spelled a pair.
export default function ShortcutKeys({
  ids,
  className,
}: {
  ids: ShortcutId[];
  className?: string;
}) {
  useShortcutOverrides();
  const groups = formatChords(ids.map(chordFor));
  return (
    <KbdGroup className={className}>
      {groups.map((caps, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="text-muted-foreground">/</span>}
          {caps.map((cap, j) => (
            <Kbd key={j}>{cap}</Kbd>
          ))}
        </Fragment>
      ))}
    </KbdGroup>
  );
}
