/// The two writes this app makes to a tracker, as two glyphs that open menus.
///
/// One component for both surfaces that offer them — the panel's row header and
/// the issues page's list rows — since a status moved from one place and a
/// status moved from the other are the same act, and two copies would be two
/// vocabularies for it.
///
/// They call [updateIssue] themselves rather than taking a callback. There is no
/// state behind the write: it drops every cached answer and every mounted list
/// and panel re-reads off that, so a prop threaded down from `App` would carry
/// nothing the module does not already have.
///
/// [updateIssue]: ../hooks/useIssues.ts
import { useState } from "react";

import IssueStateIcon, { IssuePriorityIcon, PRIORITY_LABEL } from "@/components/IssueStateIcon";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { updateIssue } from "@/hooks/useIssues";

import type { IssuePriority, IssueState } from "@/types/events";

/// What a menu needs to name the issue it writes to. Satisfied by both `Issue`
/// and `IssueDetail`, which is what lets one component serve a list row and an
/// opened body without knowing which it has.
type Target = { identifier: string; id: string };

/// One row of a menu. The two menus differ only in what fills this, which is
/// why the keyboard rule below is written once.
type Choice = {
  key: string;
  glyph: React.ReactNode;
  label: string;
  checked: boolean;
  pick: () => void;
};

/// Urgent first, the order Linear's own menu uses and the order `IssuePriority`
/// sorts by. "No priority" last, because it is the thing being cleared to rather
/// than a level in its own right.
const PRIORITIES: IssuePriority[] = ["urgent", "high", "medium", "low", "none"];

/// How many rows get a number. One digit, so the tenth row and beyond are
/// reachable by arrow and mouse alone — a two-key shortcut in a menu this small
/// would cost more to read than the row it saves.
const NUMBERED = 9;

/// A glyph that opens a menu, without becoming a second thing to look at.
///
/// The trigger draws the mark the row drew before it and nothing else — no
/// chevron, no border, no label. Status and priority are read at a glance far
/// more often than they are changed, so the resting row has to say exactly what
/// it said when it was only a picture; hover is where it admits to being a
/// control.
///
/// **A `span`, not a `button`.** The issues page's row is itself a `button` and
/// one cannot nest another — the same bargain `FileLink` makes, and the reason
/// the "Work on it" control beside this is a span too.
///
/// Two containment rules, and they are not the same rule twice:
///
/// - **The click is stopped on the trigger *and* on the content.** A React
///   portal bubbles through the React tree, not the DOM one, so a click on a
///   menu item reaches the row's own `onClick` and opens the pane behind the
///   menu the reader was answering.
/// - **The keydown is stopped nowhere.** `useHotkey` listens on `document`, and
///   Radix returns focus to this trigger when the menu closes — so a blanket
///   `stopPropagation` here silently killed every shortcut in the app from the
///   first time anybody opened one of these. Nothing needs it: the panel's row
///   ignores keys whose target is not itself, and a `button` row only activates
///   on its own focus.
function GlyphMenu({
  label,
  children,
  choices,
}: {
  label: string;
  children: React.ReactNode;
  choices: Choice[];
}) {
  // Controlled, so a numbered pick can close the menu it was made in. Radix
  // closes on a click of its own; a key this component handles is ours to end.
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          // `aria-label` and no `title`: the menu names the current row on
          // opening, so the OS tooltip only sat over the glyph repeating it a
          // second late — and the app's rule is that a tooltip is a real one or
          // nothing.
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          // Padding pulled back out as margin, so a hit area and a hover fill
          // around the glyph do not move the row it sits in.
          className="-m-1 flex shrink-0 items-center rounded-md p-1 transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          {children}
        </span>
      </DropdownMenuTrigger>

      {/* Wider than the trigger, which is one glyph — the content's default
          width tracks the trigger's. */}
      <DropdownMenuContent
        align="start"
        className="w-52"
        onClick={(e) => e.stopPropagation()}
        // A digit picks the row wearing it. `preventDefault` is what takes the
        // key off Radix's own typeahead, which composes after this handler and
        // would otherwise treat "3" as the start of a label to jump to.
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          const n = Number(e.key);
          if (!Number.isInteger(n) || n < 1 || n > Math.min(choices.length, NUMBERED)) return;

          e.preventDefault();
          setOpen(false);
          choices[n - 1].pick();
        }}
      >
        {choices.map((choice, i) => (
          <DropdownMenuCheckboxItem
            key={choice.key}
            checked={choice.checked}
            // The current row is a checkmark, not a disabled one: picking it
            // again is a no-op the reader can make freely, where a greyed row in
            // the middle of a list reads as a state that cannot be reached.
            onCheckedChange={choice.pick}
          >
            {choice.glyph}
            {choice.label}

            {/* The row's right edge holds one thing: the number that picks it,
                or the check saying it is already picked. They share the slot
                rather than sitting side by side — a shortcut for the state the
                issue is already in is a key that does nothing, and drawing both
                would make every row's right edge two glyphs wide to say what
                one of them says.

                Absolute, in the space the item's own `pr-8` reserves, which is
                where the check indicator draws too. */}
            {!choice.checked && i < NUMBERED && (
              <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">{i + 1}</Kbd>
            )}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// The issue's own team workflow, in the order Linear draws it.
///
/// Falls back to the plain glyph where no states were given — an issue with no
/// team on it, or a filters read that has not landed yet. A menu that opens
/// empty is worse than no menu.
export function StatusMenu({
  issue,
  state,
  states,
}: {
  issue: Target;
  /// Where the issue is now, which is what the trigger draws and what the menu
  /// checks against.
  state: IssueState;
  /// Every status its team offers. Empty is ordinary.
  states: IssueState[];
}) {
  if (!states.length) {
    return <IssueStateIcon kind={state.kind} color={state.color} label={state.name} />;
  }

  return (
    <GlyphMenu
      label={`Status: ${state.name}`}
      choices={states.map((option) => ({
        key: option.id,
        glyph: <IssueStateIcon kind={option.kind} color={option.color} />,
        label: option.name,
        checked: option.id === state.id,
        pick: () => void updateIssue(issue, { state: option }),
      }))}
    >
      <IssueStateIcon kind={state.kind} color={state.color} />
    </GlyphMenu>
  );
}

/// Linear's five levels. Fixed, unlike status — the levels are the tracker's own
/// and no workspace renames them, so this needs nothing read for it.
export function PriorityMenu({ issue, priority }: { issue: Target; priority: IssuePriority }) {
  return (
    <GlyphMenu
      label={PRIORITY_LABEL[priority]}
      choices={PRIORITIES.map((level) => ({
        key: level,
        glyph: <IssuePriorityIcon priority={level} />,
        label: PRIORITY_LABEL[level],
        checked: level === priority,
        pick: () => void updateIssue(issue, { priority: level }),
      }))}
    >
      <IssuePriorityIcon priority={priority} />
    </GlyphMenu>
  );
}
