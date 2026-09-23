import { useState } from "react";
import { RotateCcw } from "lucide-react";

import ShortcutKeys from "@/components/ShortcutKeys";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  chordFor,
  clearChord,
  holderOf,
  resetAllChords,
  resetChord,
  setChord,
  useShortcutOverrides,
} from "@/hooks/useShortcuts";
import {
  chordFromKey,
  isReserved,
  SHORTCUT_GROUPS,
  SHORTCUTS,
  type ShortcutId,
  shortcutLabel,
} from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/// Every shortcut, grouped, each rebindable in place.
///
/// Click the caps and the next chord pressed is the binding; Esc backs out. A
/// chord another action already holds is refused with that action's name
/// rather than taken — two handlers firing on one press is the collision this
/// tab exists to stop, and silently unbinding the other is worse than a
/// refusal. Overlaps the app itself gates by context are one id, so they never
/// trip it.
///
/// The recorder is a button, and it stops the keystroke at itself: every
/// `useHotkey` listens on `document`, so without that the chord being recorded
/// would also fire whatever it currently means.
///
/// Remove is Backspace inside the recorder, where Reset is a button, because
/// they mean opposite things: removing leaves the action with no chord at all,
/// where resetting puts back what this build ships. Removing that quietly
/// restored the default would hand the key back to whatever the reader was
/// clearing it for — the clash is usually with something outside Dray, and the
/// default is what clashes. A cross per row was the first shape and read as
/// noise down a column of keycaps; the recorder already owns "what is this
/// key", so emptying it lives there, named in its own prompt.
export default function ShortcutsSettings() {
  const overrides = useShortcutOverrides();
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [refused, setRefused] = useState<{ id: ShortcutId; reason: string } | null>(null);
  const anyOverride = Object.keys(overrides).length > 0;

  return (
    <div className="flex flex-col gap-5">
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group} className="flex flex-col gap-1.5">
          <h2 className="text-ui font-medium text-muted-foreground">{group}</h2>
          {SHORTCUTS.filter((s) => s.group === group).map(({ id, label }) => (
            // The hovered row takes the sidebar's hover fill, so the eye can
            // follow one label across to its keys. Dimming the rest was tried
            // and flickered as the pointer crossed the gaps between rows.
            <div key={id} className="-mx-2 flex flex-col rounded-md px-2 hover:bg-sidebar-accent/50">
              <div className="flex min-h-7 items-center justify-between gap-4">
                <span className="text-ui">{label}</span>
                <span className="flex items-center gap-0.5">
                  {id in overrides && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Reset to default"
                          onClick={() => {
                            const by = resetChord(id);
                            setRefused(
                              by ? { id, reason: `Default is used by ${shortcutLabel(by)}.` } : null,
                            );
                          }}
                        >
                          <RotateCcw />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left">Reset to default</TooltipContent>
                    </Tooltip>
                  )}
                  <button
                    type="button"
                    aria-label={
                      recording === id ? `Press keys for ${label}` : `Change shortcut for ${label}`
                    }
                    className={cn(
                      // Sized to its caps, not a minimum width: centred in a
                      // fixed box, a short chord left a wider gap to the reset
                      // button beside it than a long one did.
                      "flex h-6 cursor-pointer items-center rounded-md px-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      recording === id && "bg-muted",
                    )}
                    // Focused by hand: WebKit does not focus a button on click,
                    // so without this the keydown below never arrives and the
                    // row sits at "Press keys…" hearing nothing.
                    onClick={(e) => {
                      e.currentTarget.focus();
                      setRecording(id);
                      setRefused(null);
                    }}
                    onBlur={() => setRecording((r) => (r === id ? null : r))}
                    onKeyDown={(e) => {
                      if (recording !== id) return;
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.key === "Escape") return setRecording(null);
                      // Bare Backspace is never a chord (`chordFromKey` refuses
                      // it), so it is free to mean "no chord at all".
                      if (
                        (e.key === "Backspace" || e.key === "Delete") &&
                        !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
                      ) {
                        clearChord(id);
                        return setRecording(null);
                      }
                      const chord = chordFromKey(e);
                      if (!chord) return;
                      if (isReserved(chord))
                        return setRefused({ id, reason: "Reserved for a system shortcut." });
                      const by = holderOf(chord, id);
                      if (by) return setRefused({ id, reason: `Already used by ${shortcutLabel(by)}.` });
                      setChord(id, chord);
                      setRecording(null);
                    }}
                  >
                    {recording === id ? (
                      <span className="text-ui text-muted-foreground">
                        {chordFor(id) === null ? "Press keys…" : "Press keys, ⌫ to remove"}
                      </span>
                    ) : chordFor(id) === null ? (
                      // `ShortcutKeys` draws nothing for an unbound id, which
                      // leaves the recorder an empty box nothing invites a click
                      // on — and no way back to a binding.
                      <span className="text-ui text-muted-foreground">Not set</span>
                    ) : (
                      <ShortcutKeys ids={[id]} />
                    )}
                  </button>
                </span>
              </div>
              {refused?.id === id && (
                <p className="text-ui text-destructive">{refused.reason}</p>
              )}
            </div>
          ))}
        </section>
      ))}
      {anyOverride && (
        <Button variant="outline" size="sm" className="self-start" onClick={resetAllChords}>
          Reset all to defaults
        </Button>
      )}
    </div>
  );
}
