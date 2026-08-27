import { useId, useRef, useState, type ReactNode } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import LinearIcon from "@/components/LinearIcon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useAppSettings } from "@/hooks/useAppSettings";
import type { useIntegrations } from "@/hooks/useIntegrations";
import { useTheme } from "@/hooks/useTheme";
import { hasLightMode, THEMES, type ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type { SettingsView } from "@/types/events";

/// Where to send someone who wants to say something. Direct message rather than an
/// issue tracker: most feedback is a sentence, and a form is more than a sentence is
/// worth. The repo is beside it for the half who would rather send the fix.
const CONTACT_URL = "https://x.com/yogesharc";
const REPO_URL = "https://github.com/monorepo-labs/dray";

/// The app's preferences, such as they are.
///
/// Mounted in `App` rather than beside the gear that opens it: the sidebar
/// unmounts when it collapses, and a dialog living there would take the ⌘,
/// shortcut with it — which is the one route into this that survives a
/// collapsed sidebar.
export default function SettingsDialog({
  open,
  onOpenChange,
  integrations,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /// Owned by `App`, because the issues page and the composer read it too.
  integrations: ReturnType<typeof useIntegrations>;
}) {
  const { settings, setAnalyticsEnabled } = useAppSettings(open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Each row carries its own sentence, so there is no one description the
          dialog is described *by* — left unset, Radix warns about the missing
          `aria-describedby` and pointing it at a row would read that row's copy
          out as the dialog's purpose. */}
      {/* Wider than the dialog default. That default is sized for a question and
          two buttons; this holds prose, and at 25rem the analytics sentence broke
          across three lines with two words on the last one. */}
      <DialogContent aria-describedby={undefined} className="max-w-112">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        {/* Groups separated by space, not by rules: horizontal lines across a
            28rem dialog read as a table of contents for a page holding four
            short lists.

            Which means the space has to actually do it. Wrapped rather than left
            to `DialogContent`'s own `gap-4`, because that gap is sized for a
            question and its buttons: at 1rem the next heading sat closer to the
            control above it than to its own rows, so "Privacy" read as a caption
            on the mode segments. A group's heading has to be nearer what it
            names than what it follows, and this is the only place that ordering
            is set. */}
        <div className="flex flex-col gap-7">
          <Section title="Appearance">
            <ThemeRow />
            <ModeRow />
          </Section>

          {/* Brings its own heading, because it is the one group that may not be
              drawn at all — nothing connected renders nothing, and a heading left
              standing over that names a group the reader cannot reach. */}
          <IssueTrackerRow {...integrations} />

          <Section title="Privacy">
            <AnalyticsRow view={settings} onChange={setAnalyticsEnabled} />
          </Section>

          <Section title="Feedback">
            <ContactBlock />
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/// The palette, picked by looking at it.
///
/// Each swatch carries `data-theme` and `data-mode` itself, so the palette blocks in
/// App.css match it exactly as they match `<html>` and it paints that theme's own
/// backdrop — gradient and all. A swatch therefore cannot drift from the theme it
/// stands for, which a table of colours in this file could and eventually would.
///
/// Names are drawn, not hovered for. A colour says what a theme *looks* like and the
/// name says which one it is, and both are wanted at once — hiding either behind a
/// tooltip makes the reader work for half the answer. It also puts the name inside
/// the button, so the accessible name is the visible one rather than an `aria-label`
/// that can drift from it.
///
/// **The one row here with no description**, deliberately: the control is the
/// explanation. A sentence saying "the palette everything uses" next to two visible,
/// named palettes is words spent on something the reader has already seen.
function ThemeRow() {
  const id = useId();
  const { theme, resolvedMode, setTheme } = useTheme();
  const index = THEMES.findIndex((t) => t.id === theme);
  const { refs: swatches, onKeyDown } = useRovingGroup(THEMES.length, index, (next) =>
    setTheme(THEMES[next].id),
  );

  return (
    <SettingRow id={id} asGroup stacked label="Theme">
      <div
        role="radiogroup"
        aria-labelledby={id}
        onKeyDown={onKeyDown}
        className="flex items-start gap-3"
      >
        {THEMES.map(({ id: name, label }, i) => (
          <button
            key={name}
            ref={(el) => {
              swatches.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={theme === name}
            tabIndex={theme === name ? 0 : -1}
            onClick={() => setTheme(name)}
            className="group flex cursor-pointer flex-col items-center gap-1.5 outline-none"
          >
            <span
              data-theme={name}
              // Its own mode, not the document's. A dark-only theme in light
              // mode matches no palette block and falls through to the light
              // ramp's neutrals — so the swatch would draw a light Default that
              // clicking it does not give you, `modeFor` having forced dark.
              data-mode={hasLightMode(name) ? resolvedMode : "dark"}
              className={cn(
                "theme-swatch size-12 rounded-md border transition-colors",
                // The offset has to be the dialog's own fill rather than
                // `--background`: this floats over the sidebar, which has none.
                theme === name
                  ? "border-transparent ring-2 ring-ring ring-offset-2 ring-offset-popover"
                  : "border-border group-hover:border-muted-foreground/60 group-focus-visible:border-ring",
              )}
            />
            <span
              className={cn(
                "text-ui",
                theme === name ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {label}
            </span>
          </button>
        ))}
      </div>
    </SettingRow>
  );
}

/// Set *and* order, so a mode added later is one entry. System leads because it is
/// the answer for anyone who has already told their OS once.
const MODES: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/// Three segments rather than a switch, because there are three answers.
///
/// A switch can only ask light-or-dark, which leaves `system` — the one most people
/// want, and the only one that keeps following the OS after it is set — reachable
/// from nowhere. Driven off `mode` as *chosen*, never `resolvedMode`: the whole point
/// of System is that it reads Dark today and Light tonight, and a control drawn from
/// what is on screen would show Dark and lose the distinction.
///
/// The group disables whole on a dark-only theme rather than dropping its light
/// segments. Two segments where there were three reads as the control being broken,
/// and it would still be lying — `system` is not offerable either, since the OS can
/// resolve it to light. `modeFor` already forces dark, so the selected segment is
/// honest about what is rendering.
function ModeRow() {
  const id = useId();
  const { theme, mode, setMode } = useTheme();
  const available = hasLightMode(theme);

  const index = MODES.findIndex((m) => m.id === mode);
  const { refs, onKeyDown } = useRovingGroup(MODES.length, index, (next) =>
    setMode(MODES[next].id),
  );

  return (
    <SettingRow
      id={id}
      asGroup
      stacked
      label="Mode"
      // Nothing to say while it works — the segments name themselves. The one
      // sentence here is the reason it does not, which is the whole of why a
      // setting that cannot apply is disabled rather than hidden.
      description={
        available ? undefined : "This theme is dark only for now — the others carry both."
      }
    >
      <div
        role="radiogroup"
        aria-labelledby={id}
        onKeyDown={available ? onKeyDown : undefined}
        // Track and thumb, the way a segmented control reads everywhere: the
        // selected one is a raised card sitting *in* a recessed rail, so the
        // group says "one of these" before any label is read.
        className={cn(
          "inline-flex w-fit gap-0.5 rounded-lg bg-muted p-0.5",
          !available && "opacity-50",
        )}
      >
        {MODES.map(({ id: value, label }, i) => (
          <button
            key={value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={mode === value}
            disabled={!available}
            tabIndex={mode === value ? 0 : -1}
            onClick={() => setMode(value)}
            className={cn(
              "rounded-[calc(var(--radius)-4px)] px-3 py-1 text-ui transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              available && "cursor-pointer",
              mode === value
                ? "bg-card text-foreground shadow-2xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </SettingRow>
  );
}

/// Arrow keys inside one Tab stop, with selection following focus.
///
/// Shared by both pickers above rather than written twice. `role="radiogroup"` is a
/// promise to a screen reader that the keyboard behaves this way, and two copies of
/// it is two chances for one to quietly stop keeping it. Roving `tabIndex` is the
/// other half and lives at the call site: without it every option is its own Tab
/// stop, so tabbing through the dialog walks the palettes one at a time.
///
/// Selection follows focus because both groups are cheap to try — here trying one
/// *is* seeing it, which is the case the pattern exists for.
function useRovingGroup(
  count: number,
  index: number,
  onPick: (next: number) => void,
) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + count) % count;
    onPick(next);
    refs.current[next]?.focus();
  };

  return { refs, onKeyDown };
}

/// Two sentences: what it is for, and what it never touches.
///
/// The second one is the row's whole job. "Analytics" reads as behavioural
/// tracking to most people, and for a tool that watches you work on your own
/// code, saying plainly that conversations and activity are not collected is
/// the part worth the space. Kept short on purpose — an itemised list of
/// fields reads as something to be wary of rather than something to skim.
function AnalyticsRow({
  view,
  onChange,
}: {
  view: SettingsView | null;
  onChange: (next: boolean) => void;
}) {
  const id = useId();

  return (
    <SettingRow
      id={id}
      label="Share basic analytics"
      description={
        view?.analyticsLocked
          ? // Disabled and saying why, rather than hidden or — worse — drawn
            // from the stored value and sitting at `on` while nothing is sent.
            "Turned off for this run by DRAY_NO_ANALYTICS."
          : "Counts how many people use Dray. Your conversations and activity are never collected."
      }
    >
      <Switch
        id={id}
        // `null` until the first read lands. Disabled rather than guessing a
        // value: either guess is wrong for somebody, and the dialog's own open
        // animation is longer than a local file read.
        disabled={view === null || view.analyticsLocked}
        checked={view?.analyticsEnabled ?? false}
        onCheckedChange={onChange}
      />
    </SettingRow>
  );
}

/// The connected issue tracker — and **only** when there is one.
///
/// Connecting happens on the issues page, not here. That page is the surface
/// with nothing to show without a key, so it is where the field that fixes it
/// belongs; a second copy in this dialog would be a second form for one slot,
/// and a settings row offering to connect something the reader has never seen
/// is a row they cannot judge. What is left here is what settings are actually
/// for: seeing what is connected, and taking it back.
function IssueTrackerRow({
  integrations,
  busy,
  error,
  disconnect,
}: ReturnType<typeof useIntegrations>) {
  const id = useId();
  /// The button arms a confirm that replaces it — the same shape the sidebar's
  /// delete and the PR panel's merge use. Asked for because the key is not
  /// recoverable from here: taking it back means finding the tracker's own
  /// settings page and minting a new one, which is a long way to be sent by a
  /// button pressed on the way to somewhere else.
  const [confirming, setConfirming] = useState(false);

  const account = integrations?.linear ?? null;

  // Nothing connected is nothing to say. The reader is not missing a control:
  // the Issues page in the sidebar is where this starts.
  if (!account) return null;

  return (
    <Section title="Integrations">
      <div className="flex flex-col gap-2">
        <SettingRow
          id={id}
          label="Issue tracker"
          description={
            confirming
              ? "Dray will forget the key. Sessions keep the issues they are tagged with."
              : // The mark rather than the word, since the word is already the row's
                // subject — and it is what makes this row findable at a glance in a
                // dialog of sentences.
                <span className="flex items-center gap-1.5">
                  <LinearIcon className="size-3.5" />
                  {account.orgName}, as {account.userName}
                </span>
          }
        >
          {confirming ? (
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  await disconnect();
                  setConfirming(false);
                }}
              >
                Disconnect
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          )}
        </SettingRow>

        {error && <p className="text-ui text-destructive">{error}</p>}
      </div>
    </Section>
  );
}

/// Two ways out of the app, and deliberately not a `SettingRow`.
///
/// Nothing here is a setting — there is no state to read back — so the label a row
/// would demand ("Get in touch") sits under a heading that already says Feedback and
/// earns nothing but a third line. A sentence and the two buttons it names is the
/// whole block.
///
/// Both go through `openUrl` — the same route the PR panel and transcript links
/// take, so a link from here lands in the reader's own browser rather than turning
/// the app window into one.
function ContactBlock() {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-ui text-muted-foreground">
        Tell me what&apos;s broken, or send a PR.
      </p>
      <div className="flex items-center gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => void openUrl(CONTACT_URL)}>
          Message me
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void openUrl(REPO_URL)}>
          GitHub
        </Button>
      </div>
    </div>
  );
}

/// A run of rows under a quiet heading. The heading names the group and nothing
/// else — every row below already carries its own sentence.
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-ui font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

/// Label and control on the top line, reason at full width underneath — and
/// `stacked` for when even that is the wrong shape.
///
/// Side by side was the first shape, and it broke on the widest control here: two
/// buttons pushed the sentence into a third of the dialog, where four words took
/// three lines and the row's height jumped every time the control changed. The
/// description is prose and wants a measure; the control is a fixed thing and wants
/// an edge to sit against.
///
/// `stacked` goes further and puts the control *under* the label at full width. That
/// is for a control too wide to share a line at all — the theme swatches, the mode
/// segments — and it is also where a picker wants to be: options ranged along one
/// edge rather than pushed against the far one.
///
/// `description` is optional only for a control that shows the reader the answer
/// instead of telling them: the theme swatches, and the mode segments while they
/// work. For a switch it is never optional — a switch is a word and a state, and the
/// sentence under it is the only place "why is this off by default" can live. A
/// control that has gone *disabled* always takes one too, whatever its shape, since
/// that sentence is then the only place the reason can be said.
///
/// `asGroup` is for a control that is several elements rather than one input:
/// `htmlFor` only reaches a labelable element, so a radio group has to be pointed the
/// other way and name the label by id instead.
function SettingRow({
  id,
  label,
  description,
  asGroup = false,
  stacked = false,
  children,
}: {
  id: string;
  label: string;
  /// A node, not a string: a row whose reason is best said with a mark beside
  /// it should not have to reach past this for the privilege.
  description?: ReactNode;
  asGroup?: boolean;
  stacked?: boolean;
  children: ReactNode;
}) {
  const labelEl = (
    <label
      id={asGroup ? id : undefined}
      htmlFor={asGroup ? undefined : id}
      className="text-ui font-medium"
    >
      {label}
    </label>
  );
  const descriptionEl = description && (
    <p className="text-ui text-muted-foreground">{description}</p>
  );

  if (stacked) {
    return (
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          {labelEl}
          {descriptionEl}
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-4">
        {labelEl}
        <div className="shrink-0">{children}</div>
      </div>
      {descriptionEl}
    </div>
  );
}
