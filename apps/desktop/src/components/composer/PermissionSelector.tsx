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
import { honoursMode, stanceFor } from "@/lib/permission";
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

/// Whether this harness has a stance worth picking between.
///
/// One honoured stance is not a menu — it is a control with a single state,
/// which reads as broken. Zero is pi, which honours none: its gate is an
/// extension the reader installs and configures on disk, so there is nothing
/// here for a picker to set.
export function offersPermissionModes(harness: Harness): boolean {
  return MODES.filter((m) => honoursMode(harness, m.id)).length > 1;
}

export default function PermissionSelector({
  harness,
  value,
  onChange,
}: {
  harness: Harness;
  value: ApprovalPolicy;
  onChange: (mode: ApprovalPolicy) => void;
}) {
  // Hidden rather than disabled: a dead entry in a four-item menu reads as a
  // bug, where a shorter menu reads as this harness having fewer stances.
  const modes = MODES.filter((m) => honoursMode(harness, m.id));
  // The stance that will actually be applied, not the one the composer happens
  // to hold. The pref is global and defaults to `auto`, so a reader arriving
  // from Claude Code carries `auto` into a pi session — which honours no such
  // thing, and whose send path folds it to `bypassPermissions`. Reading `value`
  // raw put "Auto" on a session about to run ungated: the milder name over the
  // wider behaviour, which is the worse direction to be wrong in. `stanceFor`
  // is the same call the send path records with, so the two cannot disagree.
  //
  // The radio group reads it too, or the menu opens with nothing checked
  // underneath a trigger that just named a stance.
  const stance = stanceFor(harness, value);
  const selected = MODES.find((m) => m.id === stance);

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
          value={stance}
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
