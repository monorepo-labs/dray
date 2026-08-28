import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Harness } from "@/types/events";

/// Named as the reader knows them, not as the wire spells them.
const HARNESSES: { id: Harness; label: string }[] = [
  { id: "claude_code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

/// Which agent runs the session.
///
/// Creation-time only, like the project and branch pickers beside it: the
/// harness is the child process, so changing it means a different agent with a
/// different conversation, not a setting on this one. The session header names
/// it afterwards.
///
/// Sits first in the row because everything to its right depends on it — the
/// model list is per-harness, and picking Codex changes what the model picker
/// can even offer.
export default function HarnessSelector({
  value,
  onChange,
}: {
  value: Harness;
  onChange: (harness: Harness) => void;
}) {
  const selected = HARNESSES.find((h) => h.id === value);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="px-1.5 text-ui text-muted-foreground"
              aria-label="Switch agent"
            >
              {selected?.label ?? "Agent"}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Switch agent</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => onChange(v as Harness)}
        >
          {HARNESSES.map((harness) => (
            <DropdownMenuRadioItem
              key={harness.id}
              value={harness.id}
              className="text-ui"
            >
              {harness.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
