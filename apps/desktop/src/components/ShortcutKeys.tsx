import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, type LucideIcon } from "lucide-react";
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
  // An unbound id contributes nothing, and a hint naming only unbound ids draws
  // nothing at all — an empty `KbdGroup` beside a tooltip's sentence is a
  // trailing space where a chord used to be.
  const groups = formatChords(ids.map(chordFor).filter((c) => c !== null));
  if (!groups.length) return null;
  return (
    <KbdGroup className={className}>
      {groups.map((caps, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="text-muted-foreground">/</span>}
          {caps.map((cap, j) => (
            <Kbd key={j}>{capContent(cap)}</Kbd>
          ))}
        </Fragment>
      ))}
    </KbdGroup>
  );
}

/// The arrow glyphs `keyLabel` spells, as icons.
///
/// A `←` is a text character drawn on the font's own baseline, so inside a cap
/// it sits a pixel high beside `⌘` and thins out at keycap size. The icon is
/// centred in its own box and stroked like every other glyph in the chrome.
/// Read off the formatted cap rather than the chord, since two chords sharing
/// modifiers fold into one cap (`←→`) before this ever sees them.
const ARROW_ICONS: Record<string, LucideIcon> = {
  "\u2190": ArrowLeft,
  "\u2191": ArrowUp,
  "\u2192": ArrowRight,
  "\u2193": ArrowDown,
};

function capContent(cap: string) {
  const chars = [...cap];
  if (!chars.some((c) => ARROW_ICONS[c])) return cap;
  return chars.map((c, i) => {
    const Icon = ARROW_ICONS[c];
    return Icon ? <Icon key={i} /> : <span key={i}>{c}</span>;
  });
}
