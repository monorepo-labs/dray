import { ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type PickOption = { sessionId: string; title: string; face: React.ReactNode };

/// The first row of a bot-row Diff or Files tab's side column: which session
/// the tab shows (#892). The tab itself carries the same title, so this is
/// where it is changed rather than where it is said.
export default function PickTarget({
  options,
  value,
  current,
  onPick,
}: {
  options: PickOption[];
  value: string;
  /// The picked session as drawn, which may be in no option: a task settled
  /// since keeps its tab on it.
  current: PickOption;
  onPick: (sessionId: string) => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border px-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Showing ${current.title}. Pick another`}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-ui transition-colors hover:bg-foreground/5"
          >
            {current.face}
            <span className="min-w-0 flex-1 truncate">{current.title}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
          <DropdownMenuRadioGroup value={value} onValueChange={onPick}>
            {options.map((o) => (
              <DropdownMenuRadioItem key={o.sessionId} value={o.sessionId} className="text-ui">
                {o.face}
                <span className="min-w-0 truncate">{o.title}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
