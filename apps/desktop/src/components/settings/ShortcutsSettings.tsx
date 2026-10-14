import { useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

import ShortcutKeys, { DigitKeys } from "@/components/ShortcutKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  anyMods,
  DIGIT_CHORDS,
  type DigitChordId,
  digitSlot,
  heldMods,
  type Mods,
  modsAfterUp,
  modsFor,
  sameMods,
  setMods,
  usableMods,
  useMods,
} from "@/lib/digitChords";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";

/// Who already answers `mods` plus one of the first `slots` digits: another
/// digit row, or a registry chord. Only the platform accelerator can collide
/// with the registry, which spells nothing else under a digit.
function digitClash(mods: Mods, slots: number, except?: DigitChordId): string | null {
  const row = DIGIT_CHORDS.find((c) => c.id !== except && sameMods(modsFor(c.id), mods));
  if (row) return row.label;
  const accel = IS_MAC ? mods.meta && !mods.ctrl : mods.ctrl && !mods.meta;
  if (!accel) return null;
  const by = [..."1234567890"]
    .slice(0, slots)
    .map((key) => holderOf({ key, meta: true, shift: mods.shift, alt: mods.alt }))
    .find((id) => id !== null);
  return by ? shortcutLabel(by) : null;
}

/// One row for a modifier set bound over a run of digits.
///
/// Records modifiers alone: everything held is collected, and the set is taken
/// the moment the last key comes up, since with no digit to press there is no
/// other keystroke that could say "done".
function DigitRow({ id, label, slots }: { id: DigitChordId; label: string; slots: number }) {
  const mods = useMods(id);
  const [recording, setRecording] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const peak = useRef<Mods | null>(null);
  const fallback = DIGIT_CHORDS.find((c) => c.id === id)!.mods;
  const stop = () => {
    peak.current = null;
    setRecording(false);
  };
  return (
    <div className="-mx-2 flex flex-col rounded-md px-2 hover:bg-sidebar-accent/50">
      <div className="flex min-h-7 items-center justify-between gap-4">
        <span className="text-ui text-foreground/70">{label}</span>
        <span className="flex items-center gap-0.5">
          {!sameMods(mods, fallback) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Reset to default"
                  onClick={() => {
                    const by = digitClash(fallback, slots, id);
                    if (by) return setRefused(`Default is used by ${by}.`);
                    setMods(id, null);
                    setRefused(null);
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
            aria-label={recording ? `Press modifiers for ${label}` : `Change shortcut for ${label}`}
            className={cn(
              "flex h-6 cursor-pointer items-center rounded-md px-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              recording && "bg-muted",
            )}
            onClick={(e) => {
              e.currentTarget.focus();
              setRecording(true);
              setRefused(null);
            }}
            onBlur={stop}
            onKeyDown={(e) => {
              if (!recording) return;
              e.preventDefault();
              e.stopPropagation();
              if (e.key === "Escape") return stop();
              const held = heldMods(e.nativeEvent);
              const p = peak.current;
              peak.current = p
                ? { meta: p.meta || held.meta, ctrl: p.ctrl || held.ctrl, alt: p.alt || held.alt, shift: p.shift || held.shift }
                : held;
            }}
            onKeyUp={(e) => {
              const next = peak.current;
              if (!recording || !next || anyMods(modsAfterUp(e.nativeEvent))) return;
              e.preventDefault();
              e.stopPropagation();
              peak.current = null;
              if (!usableMods(next)) return setRefused("Hold ⌘, ⌃ or ⌥.");
              const by = digitClash(next, slots, id);
              if (by) return setRefused(`Already used by ${by}.`);
              setMods(id, next);
              setRefused(null);
              setRecording(false);
            }}
          >
            {recording ? (
              <span className="text-ui text-muted-foreground">Hold modifiers, then let go…</span>
            ) : (
              <DigitKeys id={id} />
            )}
          </button>
        </span>
      </div>
      {refused && <p className="text-ui text-destructive">{refused}</p>}
      {/* ⌘⇧3/4/5 never reach the app. */}
      {IS_MAC && mods.meta && mods.shift && !mods.ctrl && !mods.alt && slots >= 3 && (
        <p className="text-ui text-muted-foreground">macOS keeps ⌘ Shift 3, 4 and 5 for screenshots.</p>
      )}
    </div>
  );
}

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
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (label: string, group: string) =>
    !q || label.toLowerCase().includes(q) || group.toLowerCase().includes(q);
  const shown = SHORTCUT_GROUPS.map((group) => ({
    group,
    rows: SHORTCUTS.filter((s) => s.group === group && matches(s.label, group)),
    digits: DIGIT_CHORDS.filter((c) => c.group === group && matches(c.label, group)),
  })).filter((g) => g.rows.length + g.digits.length > 0);

  return (
    <div className="flex flex-col gap-5">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        // Escape empties the field first; the page's own Escape listener
        // honours `defaultPrevented`, so leaving takes a second press.
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.preventDefault();
            setQuery("");
          }
        }}
        placeholder="Search shortcuts"
        aria-label="Search shortcuts"
        spellCheck={false}
        autoFocus
      />
      {shown.length === 0 && <p className="text-ui text-muted-foreground">No shortcut matches.</p>}
      {shown.map(({ group, rows, digits }) => (
        <section key={group} className="flex flex-col gap-1.5">
          <h2 className="text-ui font-medium text-foreground">{group}</h2>
          {rows.map(({ id, label }) => (
            // The hovered row takes the sidebar's hover fill, so the eye can
            // follow one label across to its keys. Dimming the rest was tried
            // and flickered as the pointer crossed the gaps between rows.
            <div key={id} className="-mx-2 flex flex-col rounded-md px-2 hover:bg-sidebar-accent/50">
              <div className="flex min-h-7 items-center justify-between gap-4">
                <span className="text-ui text-foreground/70">{label}</span>
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
                      const slot = digitSlot(e.nativeEvent.code);
                      const row =
                        slot !== null &&
                        DIGIT_CHORDS.find(
                          (c) =>
                            slot < c.slots &&
                            sameMods(modsFor(c.id), {
                              meta: IS_MAC && chord.meta,
                              ctrl: !IS_MAC && chord.meta,
                              alt: chord.alt,
                              shift: chord.shift,
                            }),
                        );
                      if (row) return setRefused({ id, reason: `Already used by ${row.label}.` });
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
          {digits.map((c) => (
            <DigitRow key={c.id} id={c.id} label={c.label} slots={c.slots} />
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
