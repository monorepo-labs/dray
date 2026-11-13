import { Server } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/// A server glyph saying a task runs on another machine, the name in its
/// tooltip. Glyph alone, since a task row is already full; `null` for This Mac.
export default function MachineMark({ machine, className }: { machine: string | null; className?: string }) {
  if (!machine) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={`Runs on ${machine}`} className={cn("flex shrink-0 text-muted-foreground", className)}>
          <Server className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">Runs on {machine}</TooltipContent>
    </Tooltip>
  );
}
