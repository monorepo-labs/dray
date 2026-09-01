import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

import { openUrl } from "@tauri-apps/plugin-opener";

import AppIcon from "@/components/AppIcon";
import LinearIcon from "@/components/LinearIcon";
import TabButton from "@/components/TabButton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useAppSettings } from "@/hooks/useAppSettings";
import type { useIntegrations } from "@/hooks/useIntegrations";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { useTheme } from "@/hooks/useTheme";
import {
  cachedApps,
  fileOpenerChoices,
  load,
  OPEN_FILE_KEY,
  pickFileOpener,
} from "@/lib/openWith";
import TranscriptionSettings from "@/components/settings/TranscriptionSettings";
import { useTranscriptionSettings } from "@/hooks/useTranscription";
import { IS_MAC } from "@/lib/platform";
import { hasLightMode, THEMES, type ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type { ExternalApp, SettingsView, UpdateChannel } from "@/types/events";

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
  initialTab = "appearance",
  integrations,
  updateChannel,
  onUpdateChannelChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /// Which tab to open on. The composer's mic button sends the reader straight
  /// to Transcription when no model is downloaded, which is the whole reason
  /// this is a prop rather than internal state.
  initialTab?: SettingsTab;
  /// Owned by `App`, because the issues page and the composer read it too.
  integrations: ReturnType<typeof useIntegrations>;
  /// Owned by `useUpdater`, for the reason its own doc comment gives: a second
  /// `useLocalStorage` here would write a value the checking effect never sees.
  updateChannel: UpdateChannel;
  onUpdateChannelChange: (next: UpdateChannel) => void;
}) {
  const { settings, setAnalyticsEnabled } = useAppSettings(open);
  const transcription = useTranscriptionSettings(open);

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

        <SettingsTabs initialTab={initialTab}>
          {{
            appearance: (
              <Section>
                <ThemeRow />
                <ModeRow />
              </Section>
            ),
            transcription: (
              <TranscriptionSettings
                status={transcription.status}
                downloads={transcription.downloads}
                onDownload={transcription.download}
                onCancelDownload={transcription.cancelDownload}
                onDelete={transcription.remove}
                onSelectModel={transcription.selectModel}
                onSelectDevice={transcription.selectDevice}
                onSetMute={transcription.setMute}
              />
            ),
            integrations: (
              <Section>
                <OpenFilesRow />
                {/* Draws nothing until something is connected, which is why it
                    carries no heading of its own — a heading left standing over
                    nothing names a group the reader cannot reach. Connecting
                    happens on the issues page. */}
                <IssueTrackerRow {...integrations} />
              </Section>
            ),
            about: (
              <>
                <Section>
                  <BetaUpdatesRow
                    channel={updateChannel}
                    onChange={onUpdateChannelChange}
                  />
                  <AnalyticsRow view={settings} onChange={setAnalyticsEnabled} />
                </Section>
                {/* The one block here with no label of its own, so it is the one
                    that still wants a heading over it. */}
                <Section title="Feedback">
                  <ContactBlock />
                </Section>
              </>
            ),
          }}
        </SettingsTabs>
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

/// Which app a filename in the transcript opens in.
///
/// Finder is the default and the fallback, and it *reveals* rather than opens —
/// which is also what the link did before this setting existed, so an
/// uninstalled editor or a launch that fails costs the preference and never the
/// click. The menu offers editors and Finder only: a terminal is in the panel
/// button's list because it can be handed a directory, and handing it one file
/// answers nothing.
///
/// Drawn disabled rather than hidden wherever it cannot apply, since the
/// sentence underneath is then the only place the reason can be said. Off macOS
/// there is no detection at all; on macOS with no editor installed there is a
/// list of one, which is a menu that cannot change anything.
function OpenFilesRow() {
  const id = useId();
  const [stored, setStored] = useLocalStorage<string | null>(OPEN_FILE_KEY, null);
  // `null` until the first read lands, so an empty list can still mean "this
  // machine has nothing" rather than "nobody has asked yet".
  const [apps, setApps] = useState<ExternalApp[] | null>(() => {
    const warm = cachedApps();
    return warm.length ? warm : null;
  });

  /// Asks again, on mount and whenever the menu opens — an editor installed
  /// while Dray was running is otherwise absent until a restart, and the menu
  /// opening is the one moment the list has to be current.
  const refresh = useCallback(() => {
    void load().then(setApps);
  }, []);

  useEffect(refresh, [refresh]);

  const choices = fileOpenerChoices(apps ?? []);
  const pick = pickFileOpener(apps ?? [], stored);
  const editors = choices.filter((app) => app.kind === "editor");

  const unavailable = !IS_MAC
    ? "Opening a file in another app is macOS-only for now."
    : apps !== null && editors.length === 0
      ? "No editor Dray knows about is installed, so filenames open in Finder."
      : null;

  return (
    <SettingRow
      id={id}
      label="Open files with"
      description={
        unavailable ??
        "Where a filename in the chat opens. Markdown opens in the panel instead, and Finder selects a file rather than opening it."
      }
    >
      {/* Opening the menu re-reads the list — see `refresh`. */}
      <DropdownMenu onOpenChange={(open) => open && refresh()}>
        <DropdownMenuTrigger asChild>
          <Button
            id={id}
            variant="outline"
            size="sm"
            // `apps === null` is the read not having landed. Disabled rather
            // than drawn from a guess, the same bargain the analytics switch
            // makes — either guess is wrong for somebody.
            disabled={apps === null || unavailable !== null}
            className="min-w-36 justify-between font-normal"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {pick && <AppIcon app={pick} className="size-4" />}
              {/* "None" rather than "Finder" where nothing was detected: off
                  macOS the reveal is some other file manager, and naming
                  Finder there would be a control lying about what it does. */}
              <span className="truncate">{pick?.name ?? "None"}</span>
            </span>
            <ChevronDown className="size-3 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>

        {/* Aligned to the end because the control sits at the dialog's right
            edge, where a start-aligned menu opens past it. */}
        <DropdownMenuContent align="end" className="min-w-44">
          {choices.map((app, i) => (
            <Fragment key={app.path}>
              {/* An inset dotted rule between the editors and Finder,
                  `PickerMenu`'s own idiom and the same one the panel's split
                  button uses. Finder is a different kind of answer, and a flat
                  list of both reads as one. */}
              {i > 0 && choices[i - 1].kind !== app.kind && (
                <DropdownMenuSeparator className="mx-2 my-1 h-0 border-t border-dotted border-border/80 bg-transparent" />
              )}
              <DropdownMenuItem
                onSelect={() => setStored(app.path)}
                className="cursor-pointer"
              >
                <AppIcon app={app} className="size-4" />
                <span className="flex-1 truncate">{app.name}</span>
                {app.path === pick?.path && <Check className="size-3.5 shrink-0" />}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
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

  const move = (next: number) => {
    onPick(next);
    refs.current[next]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Home and End are part of the same promise the arrows are: a screen reader
    // told this is a radio group or a tab list expects all four.
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      move(e.key === "Home" ? 0 : count - 1);
      return;
    }

    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    move((index + step + count) % count);
  };

  return { refs, onKeyDown };
}

/// Which manifest updates come from.
///
/// A button that arms a confirm, the disconnect row's shape exactly — and not a
/// switch, which was the first draft. The change wants confirming, because it
/// makes the app start downloading a different build on its own; a switch that
/// must be confirmed cannot move on click, and a switch that does not move
/// reads as broken. A button carries the ask honestly: its label names the act
/// (Turn on / Turn off), which also says which channel is live.
///
/// Sits in About because that tab is where the app talks about itself: which
/// build you are running, and what it reports back.
///
/// The description is one line, and deliberately not the mechanism. An earlier
/// draft spent a second sentence on the fact that switching back is not a
/// downgrade — true, and nobody asked: the reader wants to know what they get,
/// not how the updater compares versions. `useUpdater`'s own comments hold
/// that. It also stays put while the confirm is up.
function BetaUpdatesRow({
  channel,
  onChange,
}: {
  channel: UpdateChannel;
  onChange: (next: UpdateChannel) => void;
}) {
  const id = useId();
  /// The channel the reader is about to move to, or null at rest. Resets with
  /// the dialog, since the tab bodies are switched rather than hidden.
  const [confirming, setConfirming] = useState<UpdateChannel | null>(null);

  return (
    <SettingRow
      id={id}
      label="Beta updates"
      description="Get new versions early, before they're fully tested."
    >
      {confirming ? (
        <div className="flex items-center gap-1.5">
          {/* Takes the focus the unmounting button just dropped — not stealing,
              since a keyboard user was on this very spot. Cancel, not the verb,
              so Enter pressed twice out of habit changes nothing. */}
          <Button
            autoFocus
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(null)}
          >
            Cancel
          </Button>
          {/* Not the verb again — the button just pressed said that, and the
              same word twice reads as the press not having landed. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onChange(confirming);
              setConfirming(null);
            }}
          >
            Confirm
          </Button>
        </div>
      ) : (
        <Button
          id={id}
          variant="outline"
          size="sm"
          onClick={() => setConfirming(channel === "beta" ? "stable" : "beta")}
        >
          {channel === "beta" ? "Turn off" : "Turn on"}
        </Button>
      )}
    </SettingRow>
  );
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

/// A run of rows, optionally under a quiet heading.
///
/// The heading is the exception now that the groups are tabs: the tab's own
/// label already names what is below it, so a heading repeating it is a second
/// copy of one word. What still earns one is a block carrying no label of its
/// own, which is the feedback links and nothing else.
///
/// Untitled it is still worth being: the tab panel spaces its groups apart at
/// `gap-7` and this holds rows together at `gap-4`, which is the whole of how a
/// heading ends up nearer what it names than what it follows.
function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      {title && <h2 className="text-ui font-medium text-muted-foreground">{title}</h2>}
      {children}
    </section>
  );
}

/// Set *and* order, so a group added later is one entry plus one body.
const SETTINGS_TABS = ["appearance", "transcription", "integrations", "about"] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

const TAB_LABELS: Record<SettingsTab, string> = {
  appearance: "Appearance",
  transcription: "Transcription",
  integrations: "Integrations",
  about: "About",
};

/// The dialog's groups as a tab row, drawn as the app's tabs everywhere else.
///
/// One long scroll was the first shape and it stopped working at five groups:
/// the reader who came to change one thing read past four others to find it,
/// and every group added made that worse. Tabs across the top rather than a
/// rail down the side, because the dialog is 28rem and a rail takes a third of
/// that from the prose — the analytics sentence already broke across three
/// lines at 25rem.
///
/// **About holds privacy and feedback**, which is the one grouping worth
/// arguing about. Both answer what the app does with you rather than what it
/// does for you: what is collected, and how to reach the person who wrote it.
/// Privacy alone was too thin to be a tab and reads oddly next to Appearance.
///
/// Bodies are switched, not hidden, unlike the right panel's. There is no
/// scroll position or expensive render to preserve here, and mounting all three
/// would have the external-app scan run every time the dialog opens whichever
/// tab the reader wanted. The pick resets on close for the same reason the
/// dialog's own open state is not persisted.
function SettingsTabs({
  initialTab,
  children,
}: {
  initialTab: SettingsTab;
  children: Record<SettingsTab, ReactNode>;
}) {
  const id = useId();
  // An initializer, not an effect: `DialogContent` unmounts on close, so every
  // open builds this fresh and the caller's tab is simply where it starts.
  // That is also what keeps "the pick resets on close" true.
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  const index = SETTINGS_TABS.indexOf(tab);
  const { refs, onKeyDown } = useRovingGroup(SETTINGS_TABS.length, index, (next) =>
    setTab(SETTINGS_TABS[next]),
  );

  return (
    <div className="flex flex-col gap-5">
      <div
        role="tablist"
        aria-label="Settings"
        onKeyDown={onKeyDown}
        className="flex items-center gap-0.5"
      >
        {SETTINGS_TABS.map((value, i) => (
          <TabButton
            key={value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            id={`${id}-${value}`}
            aria-selected={tab === value}
            aria-controls={`${id}-panel`}
            tabIndex={tab === value ? 0 : -1}
            active={tab === value}
            onClick={() => setTab(value)}
            className="cursor-pointer"
          >
            {TAB_LABELS[value]}
          </TabButton>
        ))}
      </div>

      {/* Fixed, and scrolling past it. A floor was enough while the tabs were
          within a line or two of each other, and stopped being enough the
          moment Transcription arrived carrying a list of models — the dialog
          then doubled in height on the way in and halved on the way out, which
          reads as the window jumping rather than as the content changing.
          Raising the floor to the tallest tab instead would spend that height
          on About, which is four lines.

          The negative margin is for the model rows' focus ring: `overflow-y`
          clips the other axis too, so a ring drawn at the panel's own edge
          loses its outer edge without it. */}
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${tab}`}
        // `shrink-0` on the sections, since a column flex item's default is to
        // shrink toward its content before the container agrees to scroll.
        // Capped against the viewport as well as fixed: the height is still
        // one number for every tab, so nothing jumps on a switch, but a short
        // window gets a dialog that fits inside it rather than one running off
        // both ends.
        className="-mx-1 flex h-[32rem] max-h-[60vh] flex-col gap-7 overflow-y-auto px-1 [&>*]:shrink-0"
      >
        {children[tab]}
      </div>
    </div>
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
