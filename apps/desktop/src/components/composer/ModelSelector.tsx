import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Effort, Model, ModelId } from "@/types/events";

const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export default function ModelSelector({
  models,
  modelId,
  effort,
  onChange,
}: {
  models: Model[];
  modelId: ModelId;
  effort: Effort | null;
  onChange: (modelId: ModelId, effort: Effort | null) => void;
}) {
  // Controlled so a click on a submenu trigger can close the whole menu; Radix
  // otherwise keeps the parent open for the submenu it just opened on hover.
  const [open, setOpen] = useState(false);

  const selected = models.find((m) => m.id === modelId) ?? null;

  /// What a row would resolve to if clicked: the live effort for the model
  /// already selected, each other model's own default. Mirrors the resolution
  /// in `useSessions`, so the menu can't advertise an effort the send wouldn't use.
  const rowEffort = (model: Model): Effort | null =>
    model.id === modelId ? effort : model.defaultEffort;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            {/* `text-ui` over the button's own `text-sm`: the toolbar has to track
                the runtime font-size setting like the rest of the chrome. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1 px-1.5 text-ui text-muted-foreground"
            >
              {/* Effort is a qualifier on the model, not part of its name, so it's
                  held back a step rather than reading as one long label. */}
              <span>{selected?.label ?? modelId}</span>
              {effort && (
                <span className="text-muted-foreground/60">{EFFORT_LABELS[effort]}</span>
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          Switch model
          <KbdGroup>
            <Kbd>Shift</Kbd>
            <Kbd>Shift</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="start" className="min-w-48">
        {models.map((model) =>
          model.efforts.length ? (
            // One row: hover opens the effort submenu (Radix's own behaviour),
            // click picks the model and leaves its effort alone. Splitting the
            // two into separate items would give the row two hover states.
            <DropdownMenuSub key={model.id}>
              <DropdownMenuSubTrigger
                className="cursor-pointer gap-1 text-ui"
                onClick={() => {
                  onChange(model.id, null);
                  setOpen(false);
                }}
              >
                {model.label}
                {rowEffort(model) && (
                  <span className="text-muted-foreground/60">
                    {EFFORT_LABELS[rowEffort(model)!]}
                  </span>
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {model.efforts.map((level) => (
                  <DropdownMenuItem
                    key={level}
                    className="text-ui"
                    onSelect={() => {
                      onChange(model.id, level);
                      setOpen(false);
                    }}
                  >
                    {EFFORT_LABELS[level]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : (
            // No submenu and no chevron for a model with no effort levels.
            <DropdownMenuItem
              key={model.id}
              className="text-ui"
              onSelect={() => onChange(model.id, null)}
            >
              {model.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
