import { GitCompare } from "lucide-react";

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
}: {
  onToggle: () => void;
  open: boolean;
  /// The last turn left the tree changed. Swaps the glyph for a git one while
  /// the pane is closed, so one button both says there is something to see and
  /// is the way to it — which is the whole of the quick-access rail that was
  /// otherwise going to sit beside it. Nothing to say once the pane is open:
  /// the changes are on screen, and the toggle goes back to being a toggle.
  changes?: boolean;
}) {
  const indicating = changes && !open;

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
          aria-label={indicating ? "Show changes" : "Toggle panel"}
          className={cn(
            "transition-opacity",
            indicating ? "opacity-100" : "opacity-80 hover:opacity-100",
          )}
        >
          {indicating ? (
            // Smaller than the panel glyph so it reads the same size: this one
            // runs corner to corner of its 24 box while the panel icon is 14
            // units tall in the same box, so matching the numbers makes it the
            // visibly larger of the two. Stroke 1.5 to match the hand-drawn
            // chrome around it; lucide draws at 2. The colour is on the glyph
            // rather than the button because `ghost` sets `hover:text-
            // foreground`, which would grey it out under the cursor.
            <GitCompare className="size-4 text-accent-command" strokeWidth={1.5} />
          ) : (
            <PanelRightIcon className="size-4.5" dim={!open} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">
        {indicating ? "Last turn's changes" : "Toggle Panel"}
        <KbdGroup>
          <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>E</Kbd>
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  );
}

/// Which body the right panel is showing. Ordered as the tabs read: changes
/// first, since it answers "what just happened" and is the one open by default.
export const PANEL_TABS = ["changes", "subagents"] as const;

export type PanelTab = (typeof PANEL_TABS)[number];

const LABELS: Record<PanelTab, string> = {
  changes: "Changes",
  subagents: "Subagents",
};

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
        {PANEL_TABS.map((value) => (
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
      </div>

      {children}
    </aside>
  );
}
