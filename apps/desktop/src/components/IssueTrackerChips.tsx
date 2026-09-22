import GitHubIcon from "@/components/GitHubIcon";
import LinearIcon from "@/components/LinearIcon";
import Segmented from "@/components/Segmented";
import { setIssueTracker } from "@/lib/issueTracker";

import type { IssueTracker } from "@/types/events";

/// The marks are the point here. This is one of the few places the app names a
/// tracker at all, and a segment saying "GitHub" in words would be the widest
/// thing in a row of glyphs — so the name lives in `aria-label` alone.
const OPTIONS = [
  { value: "linear", label: "Linear", content: <LinearIcon className="size-3.5" /> },
  { value: "github", label: "GitHub", content: <GitHubIcon className="size-3.5" /> },
] as const;

/// Which tracker the issue surfaces are reading — a two-way switch, and the
/// only control that moves the pick.
///
/// One component for both places it is drawn, the issues page's filter row and
/// the header of the composer's `#` menu, since flipping either has to move
/// both and two copies would be two vocabularies for one switch. It writes the
/// module store directly rather than taking a callback: there is no state
/// behind it, and every surface reading the pick is already subscribed.
///
/// **The issues page draws it whether or not both are connected**, since it is
/// the only place in the app that says a second tracker exists — hiding it put
/// the pitch for one on a screen you reach by having neither. Pressing the
/// disconnected half there lands on that tracker's connect pane, which is where
/// the press was going. The composer's `#` menu still asks `canSwitchTracker`:
/// inside a sentence being typed there is nowhere for that pane to go, so the
/// chip could only produce a list that cannot load. Neither gate lives here —
/// the row around this has its own spacing to drop.
///
/// **A switch, not two chips.** Drawn as two independent pills it said "GitHub
/// is on" and left Linear as a bare glyph floating beside it, which reads as
/// one control lit and one piece of decoration rather than as a pick out of a
/// pair.
export default function IssueTrackerChips({
  tracker,
  className,
}: {
  tracker: IssueTracker;
  className?: string;
}) {
  return (
    <Segmented
      value={tracker}
      options={OPTIONS}
      onPick={setIssueTracker}
      label="Tracker"
      className={className}
    />
  );
}
