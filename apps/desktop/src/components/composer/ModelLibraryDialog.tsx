import { useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { byProvider, matchesQuery, toggleStar } from "@/lib/starredModels";
import { cn } from "@/lib/utils";
import type { Model, ModelId } from "@/types/events";

/// The whole list, where the composer's picker draws only the shortlist.
///
/// pi's models are discovered rather than named here — every model every
/// provider the reader has logged into serves — so the list has no bound and a
/// menu of all of them is a menu nobody reads. This is where the reader decides
/// which few they work with; the picker draws that decision.
///
/// Starring is the only thing this dialog does. It does not pick a model, and
/// deliberately: a row that both starred and selected would leave no way to say
/// "next time, this one" without switching the session onto it.
export default function ModelLibraryDialog({
  open,
  onOpenChange,
  models,
  starred,
  onStarredChange,
  onRefresh,
  loading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: Model[];
  starred: ModelId[];
  onStarredChange: (next: ModelId[]) => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  const [query, setQuery] = useState("");

  const groups = useMemo(
    () => byProvider(models.filter((m) => matchesQuery(m, query))),
    [models, query],
  );

  const stars = new Set(starred);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Taller and wider than the settings dialog: this one is a list to scan,
          where that one is rows to read. */}
      <DialogContent className="flex max-h-[70vh] max-w-120 flex-col gap-3 p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>Models</DialogTitle>
          <DialogDescription>
            Turn on the ones you work with. Only those show in the picker.
          </DialogDescription>
        </DialogHeader>

        {/* No fill and no border, the search bar the issues page already uses:
            it is the one control always in the same place, so the glyph says
            "type here" without drawing a box round the list underneath. No rule
            under it either, for the same reason — the list below already starts
            with a provider heading, so the line separated two things that were
            not being confused for one another. */}
        <div className="flex h-9 shrink-0 items-center gap-2 px-5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            placeholder="Search models"
            spellCheck={false}
            // `dark:bg-transparent` as well as `bg-transparent`: the base input
            // carries `dark:bg-input/30`, the more specific rule, so a plain
            // override reads as removed in source while the fill stays on screen.
            className="h-full rounded-none border-0 bg-transparent p-0 text-ui shadow-none focus-visible:ring-0 dark:bg-transparent"
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          {/* The list is pi's answer, not a table, so it goes stale the moment
              a provider is logged in. Nothing else on screen can say so. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            title="Refresh"
            onClick={onRefresh}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {groups.length === 0 && (
            <p className="px-3 py-6 text-center text-ui text-muted-foreground">
              {loading
                ? "Reading the model list…"
                : models.length === 0
                  ? "pi reported no models. Log a provider in and refresh."
                  : `Nothing matches “${query}”.`}
            </p>
          )}

          {groups.map((group) => (
            <div key={group.provider} className="mb-1">
              {/* Muted, no fill and no glyph, the sidebar's project heading:
                  a tinted band draws a box round the quietest line on screen. */}
              <p className="px-3 pt-2 pb-1 text-ui text-muted-foreground">
                {group.provider}
              </p>
              {group.models.map((model) => {
                const isStarred = stars.has(model.id);
                return (
                  // The whole row is the target, and it carries the switch role
                  // itself — a real `Switch` here would be a button inside a
                  // button, which is invalid and gives the row two hit areas
                  // where the reader sees one. Same bargain `WorktreeToggle`
                  // makes with its own hand-drawn track.
                  <button
                    key={model.id}
                    type="button"
                    role="switch"
                    aria-checked={isStarred}
                    onClick={() => onStarredChange(toggleStar(starred, model.id))}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-ui hover:bg-accent"
                  >
                    <span className="truncate">{model.label}</span>
                    {/* The id used to sit here, and for most models it is the
                        label again with a slash in it — the same name twice on
                        one row. The state is what the row is for, so it takes
                        the slot. */}
                    <span
                      aria-hidden
                      className={cn(
                        "ml-auto flex h-4 w-7 shrink-0 items-center rounded-full p-px transition-colors",
                        isStarred ? "bg-primary" : "bg-muted-foreground/30",
                      )}
                    >
                      <span
                        className={cn(
                          "size-3.5 rounded-full bg-background transition-transform",
                          isStarred && "translate-x-3",
                        )}
                      />
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
