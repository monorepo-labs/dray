import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";

/// Which view fills the main column. Set and order in one, unlike the right
/// panel's tabs: none of these are conditional, so a Terminal view joins by
/// being added here and given a body.
export const VIEW_TABS = ["chat", "changes"] as const;

export type ViewTab = (typeof VIEW_TABS)[number];

const LABELS: Record<ViewTab, string> = {
  chat: "Chat",
  changes: "Changes",
};

/// The main column's tab row, drawn in the titlebar beside the session's name.
///
/// Styled as the right panel's tab row rather than as buttons, because they are
/// the same control: one row where exactly one entry is on. The accelerator is
/// the tab's position, so it is read off the array rather than stored per tab —
/// reordering `VIEW_TABS` moves the keys with it.
export default function ViewTabs({
  tab,
  onChange,
}: {
  tab: ViewTab;
  onChange: (tab: ViewTab) => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {VIEW_TABS.map((value, i) => (
        <Tooltip key={value}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onChange(value)}
              className={cn(
                "rounded-md px-2 py-1 text-ui transition-colors",
                tab === value
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {LABELS[value]}
            </button>
          </TooltipTrigger>
          {/* The name is already on the button, so the tooltip carries the
              keycaps alone rather than repeating it back — and with nothing to
              read, the default `px-3` is a margin around one small chip. The
              base style already tightens the *right* side for a trailing
              keycap; this matches the left to it. */}
          <TooltipContent side="bottom" className="px-1.5">
            <KbdGroup>
              <Kbd>{IS_MAC ? "⌘" : "Ctrl"}</Kbd>
              <Kbd>{i + 1}</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
