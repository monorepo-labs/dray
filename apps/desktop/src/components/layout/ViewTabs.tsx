import ShortcutKeys from "@/components/ShortcutKeys";
import TabButton from "@/components/TabButton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ShortcutId } from "@/lib/shortcuts";

/// Which view fills the main column. Set and order in one, unlike the right
/// panel's tabs: none of these are conditional, so a Terminal view joins by
/// being added here and given a body.
export const VIEW_TABS = ["chat", "changes", "browser"] as const;

export type ViewTab = (typeof VIEW_TABS)[number];

const LABELS: Record<ViewTab, string> = {
  chat: "Chat",
  changes: "Diff",
  browser: "Browser",
};

/// Per tab rather than by position, since a rebinding names the view and not
/// its slot in the row.
const VIEW_SHORTCUTS: Record<ViewTab, ShortcutId> = {
  chat: "view.chat",
  changes: "view.changes",
  browser: "view.browser",
};

/// The main column's tab row, drawn in the titlebar beside the session's name.
///
/// Styled as the right panel's tab row rather than as buttons, because they are
/// the same control: one row where exactly one entry is on.
export default function ViewTabs({
  tab,
  onChange,
}: {
  tab: ViewTab;
  onChange: (tab: ViewTab) => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {VIEW_TABS.map((value) => (
        <Tooltip key={value}>
          <TooltipTrigger asChild>
            <TabButton active={tab === value} onClick={() => onChange(value)}>
              {LABELS[value]}
            </TabButton>
          </TooltipTrigger>
          {/* The name is already on the button, so the tooltip carries the
              keycaps alone rather than repeating it back — and with nothing to
              read, the default `px-3` is a margin around one small chip. The
              base style already tightens the *right* side for a trailing
              keycap; this matches the left to it. */}
          <TooltipContent side="bottom" className="px-1.5">
            <ShortcutKeys ids={[VIEW_SHORTCUTS[value]]} />
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
