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
import { cn } from "@/lib/utils";
import type { ApprovalPolicy, Harness } from "@/types/events";

/// Listed top-down as the menu renders them, which puts `auto` — the default and
/// the most-used — nearest the trigger at the bottom of the screen.
///
/// Three omissions: `default`, which the CLI reports but its flag rejects;
/// `dontAsk`, which overlaps `auto` closely enough that offering both only
/// invites picking the wrong one; and `acceptEdits`, which was here and was
/// removed — it applied edits without asking while still asking about
/// commands, a promise too narrow to fit on a button beside `auto`.
const MODES: { id: ApprovalPolicy; label: string }[] = [
  { id: "bypassPermissions", label: "Bypass permissions" },
  { id: "manual", label: "Ask every time" },
  { id: "plan", label: "Plan" },
  { id: "auto", label: "Auto" },
];

/// Codex has no plan mode. Its own three stances are ask / approve-for-me /
/// full access, and `plan` maps onto read-only-and-ask — close, but a stance
/// Codex never names, so offering it would promise a mode it does not have.
/// Hidden rather than disabled: a dead entry in a four-item menu reads as a bug.
const HIDDEN_BY_HARNESS: Partial<Record<Harness, ApprovalPolicy[]>> = {
  codex: ["plan"],
};

export default function PermissionSelector({
  harness,
  value,
  onChange,
}: {
  harness: Harness;
  value: ApprovalPolicy;
  onChange: (mode: ApprovalPolicy) => void;
}) {
  const modes = MODES.filter(
    (m) => !(HIDDEN_BY_HARNESS[harness] ?? []).includes(m.id),
  );
  // Read off the full list, not the filtered one: a session can be on a stance
  // this harness does not offer — a spawned one takes its parent's — and a
  // trigger reading "Permissions" would say less than the stance it is on.
  const selected = MODES.find((m) => m.id === value);

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
              aria-label="Switch permission"
            >
              {selected?.label ?? "Permissions"}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {/* No chord: Shift+Tab now cycles the model, which gets reached for far
            more often than a mode most sessions set once and leave. Effort took
            the chord first and gave it up to the model for the same reason. */}
        <TooltipContent side="top">Switch permission</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => onChange(v as ApprovalPolicy)}
        >
          {modes.map((mode) => (
            <DropdownMenuRadioItem
              key={mode.id}
              value={mode.id}
              className={cn(
                "text-ui",
                // It turns off every permission check; the picker should say so
                // before the click, not after.
                mode.id === "bypassPermissions" && "text-destructive",
              )}
            >
              {mode.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
