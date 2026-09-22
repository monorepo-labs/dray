import type { ReactNode } from "react";

import { cx } from "./Window";

/// The crew's width, fixed — not a share, and not draggable. A split pane bids
/// for width against its neighbour because both sides are places to work; this
/// column is a place to work *from*. 320 is the sidebar's own order of width,
/// which is the right comparison.
export const CREW_W = 320;

/// The sessions the conversation beside it started, one strip each.
///
/// **An edge, not a divider, and the ramp is what makes it one.** A flat border
/// is what a split draws between two places to work, and this is one place with
/// a list beside it. Full strength at the composer's end and gone by the top,
/// so it reads as this column having a side rather than as the screen being cut
/// in two. `border-image` rather than a gradient on a pseudo-element: this
/// column scrolls, and an absolutely-placed child is positioned against the
/// padding box and would slide away up the list.
///
/// No heading. The fixed width and the rows' own marks already say this is a
/// list, and a label over rows that each name themselves is chrome spent on the
/// one thing nobody has to be told.
export default function Crew({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex min-h-0 shrink-0 flex-col overflow-y-auto border-l [border-image:linear-gradient(to_bottom,transparent,var(--color-border))_1]",
        className,
      )}
      style={{ width: CREW_W }}
    >
      {children}
    </div>
  );
}

/// One strip: a header that names the session, and its transcript under it when
/// open.
///
/// Selection is weight and colour, no fill. A filled row is how a *list* marks
/// the one thing it is showing, and in a column with no borders it was the
/// loudest shape on screen.
///
/// The avatar cannot carry the two states on its own — its hue is seeded from
/// the session id, so it says *which* session and never what that session
/// wants. So the title takes the sidebar's own pair: yellow for standing still
/// behind a question, green for finished and unread.
export function CrewRow({
  title,
  tone,
  focused = false,
  open = false,
  avatar,
  trailing,
  children,
  className,
  bodyClassName,
  titleClassName,
}: {
  title: string;
  /// `command` is the yellow "waiting on you", `add` the green "unread".
  tone?: "add" | "command";
  focused?: boolean;
  open?: boolean;
  /// The session's face, drawn in a fixed 20px slot.
  avatar: ReactNode;
  /// The right-hand 20px slot — the orb while a turn is in flight, a PR glyph
  /// otherwise.
  trailing?: ReactNode;
  /// The strip's transcript. Only drawn while `open`.
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /// On the title alone, so an animation can move its tone apart from the row.
  titleClassName?: string;
}) {
  return (
    <div
      className={cx(
        "flex min-h-0 flex-col",
        // Only a *transcript* bids for height. The floor is what keeps that
        // honest once the column scrolls: `flex-1` shrinks to nothing before a
        // flex container agrees to overflow, so enough closed rows would
        // squeeze every open one down to its own header.
        open ? "min-h-64 flex-1" : "shrink-0",
        className,
      )}
    >
      <div
        className={cx(
          "group relative flex h-8 w-full shrink-0 items-center gap-2 pr-3 pl-1.5 text-left text-ui",
          focused ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <span className="ml-0.5 flex size-5 shrink-0 items-center justify-center">{avatar}</span>
        <span
          className={cx(
            "truncate",
            focused && "font-medium",
            tone === "command" && "text-accent-command",
            tone === "add" && "text-accent-add",
            titleClassName,
          )}
        >
          {title}
        </span>
        {/* One slot, and the order is the sidebar's own: checks, then the orb,
            then the standing PR state. */}
        <span className="ml-auto flex size-5 shrink-0 items-center justify-center">
          {trailing}
        </span>
      </div>

      {open && (
        <div className={cx("flex min-h-0 flex-1 flex-col overflow-hidden", bodyClassName)}>
          {children}
        </div>
      )}
    </div>
  );
}
