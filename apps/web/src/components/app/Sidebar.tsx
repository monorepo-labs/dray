import type { ReactNode } from "react";
import { CheckCheck, CircleDot, Plus, Search } from "lucide-react";

import { TitlebarIcons, TrafficLights, cx } from "./Window";

/// The sidebar's default width, and its floor too — narrower, the rows'
/// timestamps and marks start eating the title beside them.
export const SIDEBAR_WIDTH = 240;

/// A keycap. Held to the app's own: the tooltip is no longer an inverted chip,
/// so caps use the muted fill everywhere.
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-xs font-medium text-muted-foreground select-none [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/// A chord, one cap per key — `⌘` then `N`, never one cap reading `⌘N`.
export function Keys({ caps, className }: { caps: ReactNode[]; className?: string }) {
  return (
    <kbd className={cx("inline-flex items-center gap-1", className)}>
      {caps.map((cap, i) => (
        <Kbd key={i}>{cap}</Kbd>
      ))}
    </kbd>
  );
}

/// Held back from the stock keycap: in a hint row the cap *is* the row, so the
/// default fill makes a hint the loudest thing in the list.
const HINT_KEYS = "[&_kbd]:bg-muted/40 [&_kbd]:text-muted-foreground/60";

/// The three strip buttons are drawn as session rows — `/80` text, the same
/// inset — since the pane is otherwise one list.
const STRIP_BUTTON =
  "flex h-7 w-full shrink-0 cursor-default items-center justify-start gap-1 rounded-[min(var(--radius-md),12px)] border border-transparent px-1.5 text-ui font-medium whitespace-nowrap text-sidebar-foreground/80 [&_svg]:size-3.5 [&_svg]:shrink-0";

/// The sidebar column: titlebar strip, the three ways a task starts, the
/// project filter, then the list.
export default function Sidebar({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <aside
      className={cx("relative flex shrink-0 flex-col border-r border-sidebar-border", className)}
      style={{ width: SIDEBAR_WIDTH }}
    >
      {/* The toggle shares this strip with the traffic lights, so it sits at
          the right to clear them. */}
      <div className="flex h-(--titlebar-h) shrink-0 items-center justify-between px-2">
        <TrafficLights className="pl-1" />
        <TitlebarIcons />
      </div>

      <div className="flex flex-col gap-px px-2">
        <div className={STRIP_BUTTON}>
          <Plus />
          New Task
          <Keys caps={["⌘", "N"]} className="ml-auto" />
        </div>
        <div className={STRIP_BUTTON}>
          <CircleDot />
          Issues
        </div>
        <div className={STRIP_BUTTON}>
          <Search />
          Search
          <Keys caps={["⌘", "F"]} className="ml-auto" />
        </div>
      </div>

      {/* The filter is where project grouping went. The dot track under the
          label is drawn at zero opacity at rest, so it is nothing to copy. */}
      <div className="mt-4 flex items-start justify-between py-1 pr-2 pl-3">
        <span className="flex items-center gap-1 pl-1 text-ui text-muted-foreground">
          All Projects
        </span>
        <span className="grid size-6 place-items-center text-muted-foreground">
          <CheckCheck className="size-3" />
        </span>
      </div>

      {/* No right padding: the scrollbar gutter is the right-hand spacing, and
          the rows balance it themselves with `pr-0.5`. */}
      {/* `pr-2` where the app has `pr-0`: there the scrollbar gutter is the
          right-hand spacing, and a drawing has no scrollbar. */}
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-hidden pb-3 pl-2 pr-2">
        {children}
      </div>
    </aside>
  );
}

/// A group heading — a project, or one of the runs the list splits into.
export function HeadingRow({ label, className }: { label: string; className?: string }) {
  return (
    <div
      className={cx(
        "flex min-h-6 items-center truncate pr-0.5 pl-2 text-ui text-muted-foreground/70",
        className,
      )}
    >
      {label}
    </div>
  );
}

/// The break between two runs in the list. `shrink-0` is load-bearing: a bare
/// height in a flex column shrinks to nothing the moment the list overflows,
/// i.e. on exactly the long sidebar it exists for.
export function GroupBreak({ tight = false }: { tight?: boolean }) {
  return <div className={cx("shrink-0", tight ? "h-3" : "h-4")} />;
}

/// Connector geometry, in px from the row's left edge. `RAIL_X` sits just
/// inside the unread rail's slot; `STEP` is one level; `ELBOW` is how far the
/// horizontal reaches before the title starts.
const RAIL_X = 12;
const STEP = 12;
const ELBOW = 10;

/// One session. The rails are a picture of the list's own shape: `guides` holds
/// one flag per ancestor level saying whether that ancestor's line is still
/// open below this row, and `opens` says this row has children of its own.
export function SessionRow({
  title,
  depth = 0,
  guides = [],
  opens = false,
  active = false,
  unread,
  unreadClassName,
  trailing,
  className,
}: {
  title: string;
  depth?: number;
  guides?: boolean[];
  opens?: boolean;
  active?: boolean;
  /// `add` is the green "finished and unread" mark, `command` the yellow
  /// "waiting on you" one. Yellow wins where both apply.
  unread?: "add" | "command";
  /// On the mark alone, so an animation can light it apart from the row.
  unreadClassName?: string;
  trailing?: ReactNode;
  className?: string;
}) {
  // The rail this row elbows onto is its parent's, one step left of the one it
  // opens for its own children.
  const ownRail = RAIL_X + (depth - 1) * STEP;
  const parentCarriesOn = guides[depth - 1] ?? false;

  return (
    <div
      className={cx(
        // No left padding and no `gap`: the unread rail's own 8px slot is the
        // indent that padding used to provide.
        "group relative flex min-h-7 w-full items-center rounded-md pl-0 pr-0.5",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/80",
        className,
      )}
    >
      {/* The slot is always here and the rail inside it is what comes and goes:
          a mark that reflows the title would shift a row's text just because
          its agent finished. */}
      <span className="flex w-2 shrink-0 items-center self-stretch">
        {unread && (
          <span
            className={cx(
              "h-1.5 w-0.5 rounded-[1px]",
              unread === "command" ? "bg-accent-command" : "bg-accent-add",
              unreadClassName,
            )}
          />
        )}
      </span>

      {/* Every piece sits on its own pixel and no two overlap:
          `--sidebar-border` is white at 8%, so two segments sharing a column
          stack to ~15% and read as a bright patch halfway down the rail. */}
      {guides.slice(0, -1).map(
        (open, level) =>
          open && (
            <span
              key={level}
              className="pointer-events-none absolute top-0 -bottom-px w-px bg-sidebar-border"
              style={{ left: RAIL_X + level * STEP }}
            />
          ),
      )}

      {depth > 0 && (
        <>
          {/* Rows sit in a `gap-px` column, so a piece that carries on has to
              reach 1px past its own bottom edge or the rail reads dashed. */}
          <span
            className="pointer-events-none absolute top-0 w-px bg-sidebar-border"
            style={{
              left: ownRail,
              height: parentCarriesOn ? "calc(100% + 1px)" : "50%",
            }}
          />
          <span
            className="pointer-events-none absolute h-px bg-sidebar-border"
            style={{ left: ownRail + 1, top: "50%", width: ELBOW - 5 }}
          />
        </>
      )}

      {opens && (
        <span
          className="pointer-events-none absolute -bottom-px w-px bg-sidebar-border"
          style={{ left: RAIL_X + depth * STEP, top: "50%" }}
        />
      )}

      {/* A fixed slot rather than padding, so every row at a level starts its
          title on the same column whatever else the row is carrying. */}
      {depth > 0 && <span className="shrink-0" style={{ width: ownRail + ELBOW - 8 }} />}

      <span className="min-w-0 flex-1 truncate text-ui">{title}</span>

      {/* The min-width is what the *date* needs: wide enough for a month and a
          day, in `em` so it follows the interface font size. */}
      <div className="relative flex min-w-[4em] shrink-0 items-center justify-end self-stretch pl-2 text-ui">
        <span className="flex items-center whitespace-nowrap text-ui text-muted-foreground">
          {trailing}
        </span>
      </div>
    </div>
  );
}

/// The chord taught at the foot of the list.
export function HintRow({
  label,
  children,
  className,
}: {
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex min-h-7 items-center justify-between pr-0.5 pl-2 text-ui text-muted-foreground/60",
        className,
      )}
    >
      {label}
      {children}
    </div>
  );
}

export { HINT_KEYS };
