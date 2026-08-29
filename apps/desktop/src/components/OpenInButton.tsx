import { Fragment, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, TriangleAlert } from "lucide-react";

import AppIcon from "@/components/AppIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOpenApps } from "@/hooks/useOpenApps";
import { cn } from "@/lib/utils";
import type { ExternalApp } from "@/types/events";

/// How long a failed launch stays on the button, matching the update check's
/// own answered-either-way verdicts.
const FAILED_MS = 4000;

/// Hands a session's working directory to an editor, a terminal, or Finder.
///
/// A split button, not a plain menu: opening in the app you chose last is the
/// whole of what this is usually for, so the common case is one click and the
/// menu is where you go to change your mind. The two halves do two different
/// things — the left opens, the menu only picks — so nothing here launches an
/// app the reader was in the middle of choosing. The left half carries the
/// picked app's own icon rather than a generic glyph — it is the fastest way to
/// read which app a click is about to reach, and the one place in this app
/// where a full-colour brand mark earns its exception, the same bargain the
/// file icons make.
///
/// Draws nothing when no app was detected. An empty menu is a control that
/// cannot do anything, and there is no cure to name — every mac has Finder, so
/// an empty list means the scan itself found nothing rather than that the
/// reader is missing an editor.
export default function OpenInButton({ cwd, className }: { cwd: string; className?: string }) {
  const { apps, pick, select, open, refresh } = useOpenApps();

  // `open`'s own sentence when a launch failed, held briefly on the button.
  // The alternative was the developer console, where it told the reader
  // nothing and left a button that looked simply unresponsive — and a bundle
  // that has moved is exactly the failure whose cure is worth naming.
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const handleOpen = async (app: ExternalApp) => {
    const failure = await open(app, cwd);
    setError(failure);
    if (timer.current) clearTimeout(timer.current);
    // Retires itself like the update check's own verdicts do. A launch failure
    // is news about one press, not a state to sit in.
    if (failure) timer.current = setTimeout(() => setError(null), FAILED_MS);
  };

  if (!pick) return null;

  return (
    // `border-border dark:border-input`, matching the `outline` button variant,
    // because that is the app's edge for a bordered *control*. `--border` alone
    // is 10% white and is the token for a surface edge or a rule; this started
    // at `border-border/60`, which multiplied out to 6% and all but vanished on
    // a 24px-tall control.
    <div
      className={cn(
        "flex shrink-0 items-center rounded-md border border-border dark:border-input",
        className,
      )}
    >
      {/* Forced open while a failure is standing: Radix closes a tooltip on
          click, so after a failed press the reader would otherwise have a red
          glyph and no sentence unless they hovered back — and the sentence is
          the only thing that says what to do about it.

          `key` remounts the tooltip when the failure clears. Flipping `open`
          between `true` and `undefined` swaps it between controlled and
          uncontrolled, and Radix keeps its own stale open state across that —
          a fresh instance starts closed, which is what "the failure is over"
          should look like. */}
      <Tooltip key={error ? "failed" : "idle"} open={error ? true : undefined}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => void handleOpen(pick)}
            // `pl-1` against `pr-1.5`: a 16px icon in a 24px row leaves 4px
            // above and below, so 4px is what the icon's own left edge gets
            // too. The text keeps the wider side — it is set against a divider
            // rather than against air.
            className={cn(
              "flex h-6 cursor-pointer items-center gap-1.5 rounded-l-md pr-1.5 pl-1 text-ui transition-colors outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
              error ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {error ? (
              // The mark changes, the word does not: "Open" is still what the
              // button does, and swapping the label as well would make the
              // failure read as a different control having appeared.
              <TriangleAlert className="size-4 shrink-0" />
            ) : (
              // A rung up on the menu's own, and about as far as this goes: the
              // row is 24px, so 16 leaves 4px of air above and below.
              <AppIcon app={pick} className="size-4" />
            )}
            Open
          </button>
        </TooltipTrigger>
        {/* The app's name, which the button itself does not carry — the icon
            says which app to anyone who knows the mark and nothing to anyone
            who doesn't. The path is not repeated: it is on the header's own
            branch button a row away, and it is the longest thing here.

            A failure takes the slot instead, because `open`'s own sentence is
            the only thing that names the cure. `wrap`, since those sentences
            run long and truncating one clips exactly where the cure starts —
            the same reason a failed turn's notice wraps. */}
        <TooltipContent side="bottom" className={cn(error && "max-w-xs text-wrap")}>
          {error ?? `Open in ${pick.name}`}
        </TooltipContent>
      </Tooltip>

      {/* Opening the menu re-reads the list — see `useOpenApps.refresh`. */}
      <DropdownMenu onOpenChange={(isOpen) => isOpen && refresh()}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Choose which app to open in"
            className="flex h-6 cursor-pointer items-center rounded-r-md border-l border-border px-1 text-muted-foreground transition-colors outline-none dark:border-input hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>

        {/* Aligned to the end because the button sits at the panel's right
            edge, where a start-aligned menu opens off the window — the same
            reason the PR panel's merge menu carries it. */}
        <DropdownMenuContent align="end" className="min-w-44">
          {apps.map((app, i) => (
            <Fragment key={app.path}>
              {/* An inset dotted rule between runs of a kind, `PickerMenu`'s
                  own idiom. The component's separator is a full-bleed filled
                  bar, which cuts a five-entry menu in two; this clears the fill
                  and zeroes the height so a solid bar doesn't sit under the
                  dots. `/80` against the token rather than a hard-coded 8%, so
                  it stays 8% black on a light menu rather than 8% white. */}
              {i > 0 && apps[i - 1].kind !== app.kind && (
                <DropdownMenuSeparator className="mx-2 my-1 h-0 border-t border-dotted border-border/80 bg-transparent" />
              )}
              <DropdownMenuItem
                // Selects, and opens nothing — see `useOpenApps.select`.
                onSelect={() => select(app)}
                // The base item is `cursor-default`; every row here is a
                // choice, so it gets the pointer the rest of the app's
                // controls carry.
                className="cursor-pointer"
              >
                <AppIcon app={app} className="size-4" />
                <span className="flex-1 truncate">{app.name}</span>
                {/* Which one the left half will open. Without it the menu says
                    what is installed and nothing about what the button does. */}
                {app.path === pick.path && <Check className="size-3.5 shrink-0" />}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
