import { ArrowUp, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/// The composer's round send arrow, which turns into Stop while a turn runs and
/// the box is empty. Shared by the task composer and the pull requests page's
/// start box, so the two never drift apart.
export default function SendButton({
  stopping = false,
  disabled,
  onClick,
  title,
}: {
  /// Draw Stop, and act as a plain button rather than the form's submitter.
  stopping?: boolean;
  disabled: boolean;
  onClick?: () => void;
  title: string;
}) {
  // A real tooltip, not `title`: the native one draws square and can run off
  // the window's edge, and a disabled button fires no pointer events to open
  // one, so the trigger is a span around it.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex rounded-full">
          <Button
            type={stopping ? "button" : "submit"}
            size="icon-sm"
            disabled={disabled}
            onClick={onClick}
            aria-label={title}
            // The one filled button that keeps `--primary`. Everywhere but
            // Default light the two tokens are the same value, so this says
            // nothing there; on that palette it is what makes Send the
            // branded control and leaves every other filled button dark.
            className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:opacity-100"
          >
            {/* Both icons are mounted and stacked in one grid cell, so the
                swap is a transition rather than a remount — React would
                otherwise tear one out and put the other in with nothing to
                animate between them.

                Both directions run the same length. Shortening the return to
                Send was tried and read as a flinch — the two icons are one
                control changing its mind, and a swap that goes out slower
                than it comes back stops looking like one movement. */}
            <span className="grid size-4 place-items-center">
              <ArrowUp
                strokeWidth={2}
                className={cn(
                  "col-start-1 row-start-1 transition-all duration-200 ease-out motion-reduce:transition-none",
                  stopping ? "scale-50 rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100",
                )}
              />
              <Square
                className={cn(
                  "col-start-1 row-start-1 fill-current transition-all duration-200 ease-out motion-reduce:transition-none",
                  stopping ? "scale-100 rotate-0 opacity-100" : "scale-50 -rotate-90 opacity-0",
                )}
              />
            </span>
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{title}</TooltipContent>
    </Tooltip>
  );
}
