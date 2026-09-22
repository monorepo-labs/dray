import GitHubIcon from "@/components/GitHubIcon";
import LinearIcon from "@/components/LinearIcon";
import { setIssueTracker } from "@/lib/issueTracker";
import { cn } from "@/lib/utils";

import type { IssueTracker } from "@/types/events";

/// Which tracker the issue surfaces are reading — two chips, and the only
/// control that moves the pick.
///
/// One component for both places it is drawn, the issues page's filter row and
/// the header of the composer's `#` menu, since flipping either has to move
/// both and two copies would be two vocabularies for one switch. It writes the
/// module store directly rather than taking a callback: there is no state
/// behind it, and every surface reading the pick is already subscribed.
///
/// **Drawn only where both trackers are connected.** With one, there is nothing
/// to flip to and a control that can only say what it already says is chrome —
/// which is why the caller asks `canSwitchTracker` rather than this rendering
/// nothing on its own: the row around it usually has its own spacing to drop.
///
/// The marks are the point here. This is one of the few places the app names a
/// tracker at all, and a chip saying "GitHub" in words would be the widest
/// thing in a row of glyphs.
export default function IssueTrackerChips({
  tracker,
  className,
}: {
  tracker: IssueTracker;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1", className)} role="group" aria-label="Tracker">
      {(["linear", "github"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={tracker === value}
          aria-label={value === "linear" ? "Linear" : "GitHub"}
          // The composer keeps focus in its editor while this menu is open, so
          // a press that moved focus would close the picker before the click
          // landed. Harmless on the page, where nothing is listening for a
          // blur — one rule beats two behaviours.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setIssueTracker(value)}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-ui transition-colors",
            tracker === value
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {value === "linear" ? (
            <LinearIcon className="size-3.5" />
          ) : (
            <GitHubIcon className="size-3.5" />
          )}
        </button>
      ))}
    </div>
  );
}
