import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/// Off, the branch picker to the right decides where the session runs. On, it is
/// replaced by the fork point, which the CLI picks rather than the user.
export default function WorktreeToggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          role="switch"
          aria-checked={on}
          onClick={onToggle}
          className="gap-1.5 px-1.5 text-ui text-muted-foreground aria-checked:text-foreground"
        >
          {/* The track reads as on/off at a glance; the label alone left the
              state ambiguous until you'd read both it and the branch beside it. */}
          <span
            aria-hidden
            className={cn(
              "flex h-3 w-5 shrink-0 items-center rounded-full p-px transition-colors",
              on ? "bg-primary" : "bg-muted-foreground/30",
            )}
          >
            <span
              className={cn(
                "size-2.5 rounded-full bg-background transition-transform",
                on && "translate-x-2",
              )}
            />
          </span>
          Worktree
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-none whitespace-nowrap">
        Run in a worktree
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>Shift</Kbd>
          <Kbd>T</Kbd>
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  );
}
