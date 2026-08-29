import { Fragment } from "react";
import { AppWindow, Check, ChevronDown } from "lucide-react";

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
  const { apps, pick, select, open } = useOpenApps();

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
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => void open(pick, cwd)}
            // `pl-1` against `pr-1.5`: a 16px icon in a 24px row leaves 4px
            // above and below, so 4px is what the icon's own left edge gets
            // too. The text keeps the wider side — it is set against a divider
            // rather than against air.
            className="flex h-6 cursor-pointer items-center gap-1.5 rounded-l-md pr-1.5 pl-1 text-ui text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {/* A rung up on the menu's own, and about as far as this goes: the
                row is 24px, so 16 leaves 4px of air above and below. */}
            <AppIcon app={pick} className="size-4" />
            Open
          </button>
        </TooltipTrigger>
        {/* The app's name, which the button itself does not carry — the icon
            says which app to anyone who knows the mark and nothing to anyone
            who doesn't. The path is not repeated: it is on the header's own
            branch button a row away, and it is the longest thing here. */}
        <TooltipContent side="bottom">Open in {pick.name}</TooltipContent>
      </Tooltip>

      <DropdownMenu>
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
              {/* An inset rule between runs of a kind. Spacing alone was tried
                  first and read as an accident rather than as a division; the
                  component's own separator is full-bleed (`-mx-1`), which cuts
                  the menu in two and reads heavier than three groups of two
                  deserve. Held off both ends and at half the ramp's own 10%,
                  it parts the runs without becoming the loudest thing here —
                  it only has to separate two entries from two more. */}
              {i > 0 && apps[i - 1].kind !== app.kind && (
                // Dotted, the same idiom `PickerMenu` parts its own groups
                // with. The component draws a filled `h-px` bar, so the rule
                // has to move onto a border: the fill is cleared and the height
                // zeroed, or a solid bar sits under the dots.
                //
                // `/80` of the ramp's 10%, so 8% — expressed against the token
                // rather than hard-coded, which keeps it 8% *white* in dark and
                // 8% black in light instead of a white rule on a light menu.
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

/// The app's own icon, or a glyph where the bundle keeps none as an `.icns`.
///
/// `aria-hidden` and no `alt`: the name sits beside it in the menu and in the
/// tooltip on the button, so a screen reader reading the mark as well would say
/// the app twice.
function AppIcon({ app, className }: { app: ExternalApp; className?: string }) {
  if (!app.icon) return <AppWindow className={cn("shrink-0", className)} />;
  return <img src={app.icon} alt="" aria-hidden className={cn("shrink-0", className)} />;
}
