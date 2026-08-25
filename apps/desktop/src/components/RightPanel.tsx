import { GitCompare, GitPullRequest, GitPullRequestDraft, RefreshCw } from "lucide-react";

import PanelRightIcon from "@/components/icons/PanelRightIcon";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";

/// The header button that opens and closes the pane. Lives here rather than in
/// `App` so the toggle and the thing it toggles stay in one file, and outside
/// [RightPanel] itself because the pane doesn't exist before a session does —
/// the button has to outlive it. Mirrors `SidebarToggle` on the far side.
export function PanelToggle({
  onToggle,
  open,
  changes = false,
  pr = false,
  draft = false,
}: {
  onToggle: () => void;
  open: boolean;
  /// The last turn left the tree changed. Swaps the glyph for a git one while
  /// the pane is closed, so one button both says there is something to see and
  /// is the way to it — which is the whole of the quick-access rail that was
  /// otherwise going to sit beside it. Nothing to say once the pane is open:
  /// the changes are on screen, and the toggle goes back to being a toggle.
  changes?: boolean;
  /// Every one of this session's open pull requests is a draft. Draws the draft
  /// glyph rather than the plain one — the mark still appears, because a draft
  /// is still somewhere for the work to land, and it keeps the emerald so it
  /// still reads as content rather than as dimmed chrome. Shape carries the
  /// distinction, colour carries the "there is something here".
  draft?: boolean;
  /// This session has an open pull request, which outranks `changes`. A draft
  /// counts — GitHub reports one as `OPEN` with `isDraft` set.
  ///
  /// The two indicators are the same promise — "there is something here, and
  /// this is the way to it" — so only one can be drawn, and the PR is the one
  /// worth drawing: it is the tab that opens first, it is the state of the
  /// work rather than of the last turn, and it is the one that survives the
  /// next prompt landing. Green, matching the merge button it leads to.
  pr?: boolean;
}) {
  const indicating = (pr || changes) && !open;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Held back at rest — it's chrome, not content — and brought to full
            strength under the cursor. The indicator is content, so it skips
            the fade rather than announcing itself at 80%. */}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggle}
          aria-label={
            indicating ? (pr ? "Show pull request" : "Show changes") : "Toggle panel"
          }
          className={cn(
            "transition-opacity",
            indicating ? "opacity-100" : "opacity-80 hover:opacity-100",
          )}
        >
          {indicating ? (
            // Smaller than the panel glyph so it reads the same size: these run
            // corner to corner of their 24 box while the panel icon is 14 units
            // tall in the same box, so matching the numbers makes them the
            // visibly larger of the two. Stroke 1.5 to match the hand-drawn
            // chrome around it; lucide draws at 2. The colour is on the glyph
            // rather than the button because `ghost` sets `hover:text-
            // foreground`, which would grey it out under the cursor.
            pr ? (
              // `--accent-merge` is a button *fill* — dark enough to carry white
              // text — and at 1.5px stroke on a dark background it all but
              // disappeared. This is the emerald the open-PR glyph uses in the
              // panel itself, so the mark and the thing it points at match.
              draft ? (
                <GitPullRequestDraft
                  className="size-4 text-emerald-500"
                  strokeWidth={1.5}
                />
              ) : (
                <GitPullRequest className="size-4 text-emerald-500" strokeWidth={1.5} />
              )
            ) : (
              // Plain foreground, not the command yellow it started as. Yellow
              // is the app's "this is for you" — the colour of a session
              // standing still behind a question — and a turn having touched
              // files is neither a warning nor a thing to answer. It read as
              // one, every turn, which is a lot of alarm for a fact.
              <GitCompare className="size-4 text-foreground" strokeWidth={1.5} />
            )
          ) : (
            <PanelRightIcon className="size-4.5" dim={!open} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">
        {indicating
          ? pr
            ? draft
              ? "Draft pull request"
              : "Open pull request"
            : "Last turn's changes"
          : "Toggle Panel"}
        <KbdGroup>
          <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>E</Kbd>
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  );
}

/// Which body the right panel is showing. This is the set, not the order —
/// see `tabOrder`.
export const PANEL_TABS = ["changes", "subagents", "pr"] as const;

export type PanelTab = (typeof PANEL_TABS)[number];

const LABELS: Record<PanelTab, string> = {
  changes: "Changes",
  subagents: "Subagents",
  // Not "Pull Request": the short form is what anyone working on one calls it,
  // and the long one is the widest label in a row of three.
  pr: "PR",
};

/// Which tabs exist, and in what order.
///
/// The PR tab leads wherever it is drawn, and its place does not move with the
/// pull request's state. It used to: merging one sent the tab to the end, so
/// the row reshuffled under the cursor at the exact moment the reader was
/// looking at what they had just done, and ⌘⇧[ / ⌘⇧] then stepped a different
/// order than the one they had learned. A tab's position is where it is found,
/// not a ranking.
///
/// Which tab the pane *opens* onto still follows the PR's state — see `App`'s
/// `defaultTab`. That one can change freely, because it decides a first look
/// rather than where the eye goes back to.
///
/// The PR tab is absent entirely for a session that has no PR to show — see
/// `prTabVisible`. A tab whose only content is "there is nothing here" is one
/// the eye has to skip past on every session that will never have one.
export function tabOrder({ pr }: { pr: boolean }): readonly PanelTab[] {
  if (!pr) return ["changes", "subagents"];
  return ["pr", "changes", "subagents"] as const;
}

type RightPanelProps = {
  /// Closed hides the pane rather than unmounting it — its state, caches, and
  /// rendered diffs survive, so reopening is one class flip instead of a
  /// remount that refetches and re-highlights everything it just showed.
  open: boolean;
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  /// Rendered beside its tab's label. Only shown above zero — a tab reading
  /// "Subagents 0" says the same thing as the empty state one click away.
  counts?: Partial<Record<PanelTab, number>>;
  /// There is a pull request tab to draw at all — see `prTabVisible`.
  pr?: boolean;
  /// Re-reads whatever the active tab is showing, drawn at the far end of the
  /// tab row. One button rather than one per panel: it means the same thing
  /// everywhere, so it belongs to the frame and always sits in the same place.
  /// Absent for a tab with nothing to re-read.
  refresh?: { onRefresh: () => void; loading: boolean } | null;
  children: React.ReactNode;
};

/// One tab's body, kept mounted while the other tab is showing. Same reasoning
/// as `open` above: switching tabs used to unmount the changes list, so coming
/// back re-ran every fetch and every Shiki pass. The wrapper repeats the
/// aside's flex column so bodies written as direct flex children keep working.
export function TabBody({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("min-h-0 flex-1 flex-col", active ? "flex" : "hidden")}>
      {children}
    </div>
  );
}

/// The frame every right-hand inspector shares: one border, one row of tabs.
/// Bodies render inside it and own no chrome of their own, so adding a third
/// view is a tab and a component rather than another panel competing for the
/// same slot.
///
/// No close button: [PanelToggle] and ⌘E both close it, and a third affordance
/// for the same action inside the thing it dismisses is the one the eye has to
/// skip past on every read.
///
/// No titlebar spacer either, unlike the main column. This pane reaches the top
/// of the window and its tab row is what sits there; the traffic lights are on
/// the far side, so nothing needs clearing.
export default function RightPanel({
  open,
  tab,
  onTabChange,
  counts,
  pr = false,
  refresh,
  children,
}: RightPanelProps) {
  return (
    <aside
      className={cn(
        "w-[32rem] shrink-0 flex-col border-l border-border bg-sidebar",
        // Conditional `flex` rather than `flex` plus `hidden`: both set
        // `display`, so stacking them leaves the winner to stylesheet order.
        open ? "flex" : "hidden",
      )}
    >
      <div
        className="flex h-(--titlebar-h) shrink-0 items-center gap-0.5 border-b border-border px-2"
        data-tauri-drag-region="deep"
      >
        {tabOrder({ pr }).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => onTabChange(value)}
            className={cn(
              "rounded-md px-2 py-1 text-ui transition-colors",
              tab === value
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {LABELS[value]}
            {!!counts?.[value] && (
              <span className="ml-1 text-muted-foreground">{counts[value]}</span>
            )}
          </button>
        ))}

        {/* Beside the tabs rather than at the far end, and with no label: next
            to the thing it acts on, the caps read as belonging to the row
            without a word saying so. Drawn at all — rather than hidden in a
            tooltip the way the rest of the app's shortcuts are — because a
            chord for a row of two or three tabs is one nobody goes looking for.

            Three caps, not four: `[ ]` is one key with two ends rather than two
            alternatives, so splitting it reads as a chord wanting both. */}
        <KbdGroup className="ml-1.5 shrink-0 opacity-50">
          <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>⇧</Kbd>
          <Kbd>[ ]</Kbd>
        </KbdGroup>

        {/* Gone entirely on Subagents, which has nothing to re-read. It reserved
            its width back when the keycaps sat to its right and would have slid
            on that one tab; with them anchored to the tabs there is nothing left
            to hold still, and an empty box on the far edge is a slot for a
            button the reader is not waiting for. */}
        {refresh && (
          // A real tooltip rather than the `title` this used to carry: the
          // chord has to be shown somewhere, and the app puts shortcuts in
          // tooltips everywhere else. `ml-auto` moves to the wrapper, since the
          // trigger is what sits in the flex row now.
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-mr-0.5 ml-auto text-muted-foreground/60 hover:text-muted-foreground"
                onClick={refresh.onRefresh}
                aria-label="Refresh"
              >
                <RefreshCw className={cn("size-3", refresh.loading && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              Refresh
              <KbdGroup>
                <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
                <Kbd>R</Kbd>
              </KbdGroup>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {children}
    </aside>
  );
}
