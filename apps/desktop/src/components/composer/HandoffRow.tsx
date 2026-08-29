import { Button } from "@/components/ui/button";
import { HANDOFF_ICONS } from "@/components/composer/handoffIcons";
import type { HandoffAction } from "@/lib/handoff";

/// The row of canned prompts, parked behind the composer. Mostly they hand work
/// back — "I'm done, take it from here" — and one, Run server, starts work
/// instead. The name predates that second kind and is kept anyway: churning
/// `HandoffRow`, `handoffActions` and `HandoffAction` through five files buys
/// nothing this comment cannot say.
///
/// Every button here **sends a prompt** — it is the reader typing "commit"
/// without typing it. No confirm dialog and no error surface: the agent writes
/// the message with the context it already has, and whatever goes wrong is
/// reported in the transcript like any other tool failure. Which buttons exist
/// when is [handoffActions]' rule, and it is contextual — no commit offer on a
/// clean tree, no pull request from the branch the work lands on. Run server is
/// the one exception to that: it wants a session and nothing else.
///
/// It hides rather than sits, and that shape is the point. A turn that touched
/// a file is most turns, so a row drawn on "there are changes" is a row drawn
/// always — which is what makes every other tool's commit button noise. And the
/// reverse of that: finishing a turn is not the same as wanting to commit. The
/// hiding is also what lets one action be offered unconditionally, since a
/// button nobody sees until they go looking is only ever seen by someone who
/// wants it — at the cost that with a session open the row is never empty, so
/// the reserve below is now permanent.
///
/// **A clip, not the composer occluding it.** The row lives in a window pinned
/// to the card's top edge, 4px tall closed and 32px open, and the buttons sit at
/// the window's top — so growing it upward *is* the animation, and what shows
/// closed is the top 4px of each button.
///
/// The composer used to do this job by being opaque and painting later. That
/// held the whole of `--composer` hostage: the one raised surface that could
/// never be glass, on the one edge of the window most worth blending into the
/// backdrop. A clip costs the picture nothing — 4px of a button top reads the
/// same whether the rest is hidden by a card or by an edge — and hands the
/// composer back its transparency.
///
/// **The hover zone and the thing it moves are separate elements**, and they
/// have to be. With one element, the box travels with the buttons — so the
/// cursor that opened the row sits on its edge the moment it opens, and the row
/// shuts under it and reopens, forever. The zone stays put; only the inner row
/// translates, and it translates *within* the zone, so the cursor is never
/// outside it.
///
/// Three more details, each a bug the obvious version has:
///
/// - The reserve is a **fixed height** and everything else is positioned out of
///   flow inside it. In flow, the row would push the composer down and the
///   transcript up every time the cursor crossed it on its way to the input —
///   which is the one path the cursor takes most.
/// - The buttons carry **opaque fills** (`secondary`, never `outline`). Outline
///   is `bg-input/30` in the dark palette, so the transcript reads straight
///   through the part that is meant to be hidden.
/// - They take **no pointer events until the row is open**. The sliver sits
///   directly above the composer, so without this a click aimed at the input
///   and landing a few pixels high would send a commit.
export default function HandoffRow({
  actions,
  onSend,
  disabled = false,
}: {
  actions: HandoffAction[];
  onSend: (prompt: string) => void;
  /// No session to send into. Nothing fires, but the reserve still stands — its
  /// absence would move the composer.
  disabled?: boolean;
}) {
  // Near-dead now Run server is unconditional — only the new-task composer,
  // with no session to send into, reaches it. Kept because the reserve has to
  // go with the row: a sliver standing over nothing would open onto nothing.
  if (actions.length === 0) return null;

  return (
    // `h-1` against the buttons' own `h-7` is all that shows: enough to say
    // there is something under there, not enough to read as a row of buttons
    // the composer happens to be covering. This is the component's one dial —
    // raise it and more of each button stands proud.
    //
    // `px-3` matches the card's own inner padding, so the first button's edge
    // lands on the same line as the toolbar buttons inside it.
    <div className="relative h-1 px-3">
      {/* The zone, not the row. `-top-7 h-8` spans from 28px above the reserve
          to its bottom edge, turning a 4px target into a 32px one — and `w-fit`
          keeps that box off the rest of the transcript's bottom edge, where an
          invisible full-width strip would swallow clicks and text selection.
          `justify-end` is what pins the window below to the card's top edge, so
          the height it gains is gained upward. */}
      <div className="group absolute -top-7 left-3 flex h-8 w-fit flex-col justify-end">
        <div
          className={
            "overflow-hidden " +
            // The delay is symmetric on purpose: it keeps a cursor merely
            // passing through from popping the row open, and lets one that
            // overshoots on the way out come back without it having closed.
            "transition-[height] delay-150 duration-200 ease-out " +
            // 4px is all that shows: enough to say there is something under
            // there, not enough to read as a row of buttons. 32px is the
            // buttons' own 28 plus the reserve, so the open row clears the
            // card's top edge and reads as sitting above the composer rather
            // than resting on it. This is the component's one dial.
            "h-1 group-hover:h-8 group-focus-within:h-8"
          }
        >
          <div className="flex gap-1">
          {actions.map((action) => {
            const Icon = HANDOFF_ICONS[action.id];
            return (
              <Button
                key={action.id}
                type="button"
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={() => onSend(action.prompt)}
                className="pointer-events-none group-focus-within:pointer-events-auto group-hover:pointer-events-auto"
              >
                <Icon className="size-3.5" strokeWidth={1.5} />
                {action.label}
              </Button>
            );
          })}
          </div>
        </div>
      </div>
    </div>
  );
}
