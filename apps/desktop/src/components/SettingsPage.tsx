import { Fragment, useCallback, useEffect, useId, useState, type ReactNode } from "react";
import {
  BoltIcon,
  InformationCircleIcon,
  MicrophoneIcon,
  PuzzlePieceIcon,
  Square3Stack3DIcon,
  PaintBrushIcon,
  KeyIcon,
} from "@heroicons/react/16/solid";
import { ArrowLeft, Check, ChevronDown, Heart, Star } from "lucide-react";

import { openUrl } from "@tauri-apps/plugin-opener";

import AppIcon from "@/components/AppIcon";
import LinearIcon from "@/components/LinearIcon";
import rauchgAvatar from "@/assets/avatars/rauchg.jpg";
import ShortcutKeys from "@/components/ShortcutKeys";
import TabButton from "@/components/TabButton";
import ThemeSwatches, { useRovingGroup } from "@/components/ThemeSwatches";
import { CancelOrConfirm } from "@/components/settings/InRowConfirm";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import Spinner from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppSettings } from "@/hooks/useAppSettings";
import type { useIntegrations } from "@/hooks/useIntegrations";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { chordFor, useShortcutOverrides } from "@/hooks/useShortcuts";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useTheme } from "@/hooks/useTheme";
import { type ManualCheck, updateFailure } from "@/hooks/useUpdater";
import { downloadChromium, removeChromium, useChromium } from "@/lib/browser";
import { chromiumBusy, chromiumPercent, describeChromium } from "@/lib/chromium";
import {
  cachedApps,
  fileOpenerChoices,
  load,
  OPEN_FILE_KEY,
  pickFileOpener,
} from "@/lib/openWith";
import AccountsSettings from "@/components/settings/AccountsSettings";
import { SettingsHeaderSlot } from "@/components/settings/headerAction";
import ShortcutsSettings from "@/components/settings/ShortcutsSettings";
import SpacesSettings from "@/components/settings/SpacesSettings";
import TranscriptionSettings from "@/components/settings/TranscriptionSettings";
import { useTranscriptionSettings } from "@/hooks/useTranscription";
import { IS_MAC } from "@/lib/platform";
import { hasLightMode, modeFor, type ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type {
  ExternalApp,
  Project,
  SettingsView,
  UpdateChannel,
  UpdateStatus,
} from "@/types/events";

/// Where feedback and support go. Issues lead, since a report filed there is one
/// the next person with the same bug can find; a direct message is beside it for
/// what an issue is too heavy for.
const CONTACT_URL = "https://x.com/yogesharc";
const REPO_URL = "https://github.com/monorepo-labs/dray";
const ISSUES_URL = `${REPO_URL}/issues/new`;
// The landing page's own link, so both ask through one door.
const SPONSOR_URL = "https://www.patreon.com/c/yogesharc/membership";

/// People who sponsor Dray, drawn in About — the landing page's "Supported by"
/// list, kept in step by hand. Avatars are bundled rather than fetched, so the
/// row is whole offline; without one it carries an initial.
const SUPPORTERS: { name: string; note: string; url: string; avatar?: string }[] = [
  { name: "Guillermo Rauch", note: "Vercel CEO · OSS Grants", url: "https://x.com/rauchg", avatar: rauchgAvatar },
];

/// The app's preferences, such as they are.
///
/// A page taking the whole window, drawn by `App` in place of the shell, which
/// it hides rather than unmounts so every transcript is where it was left.
///
/// Mounted in `App` rather than beside the gear that opens it: the sidebar
/// unmounts when it collapses, and a page living there would take the ⌘,
/// shortcut with it. Mounted while closed too, and drawing nothing, because
/// the transcription hook's download listener has to outlive the page.
export default function SettingsPage({
  open,
  onClose,
  initialTab,
  projects,
  spaces,
  startNamingSpace,
  onSetProjectSpace,
  onRemoveProject,
  onCreateSpace,
  onRenameSpace,
  onRemoveSpace,
  onMoveSpace,
  autoHideSidebar,
  onAutoHideSidebarChange,
  integrations,
  updateStatus,
  updateManual,
  updateBlocked,
  onCheckUpdates,
  onInstallUpdate,
  updateChannel,
  onUpdateChannelChange,
  cwd,
}: {
  open: boolean;
  onClose: () => void;
  /// Which tab to open on. The composer's mic button sends the reader straight
  /// to Transcription when no model is downloaded, which is the whole reason
  /// this is a prop rather than internal state.
  initialTab: SettingsTab;
  /// Every attached project, not the active space's — this is where one is
  /// filed into a space, so a narrowed list would hide the rows to move.
  projects: Project[];
  spaces: string[];
  /// Opens the Spaces tab with its new-space field already up, which is where
  /// the sidebar's own "New space" lands.
  startNamingSpace?: boolean;
  onSetProjectSpace: (path: string, space: string | null) => void;
  onRemoveProject: (path: string) => void;
  onCreateSpace: (name: string) => void;
  onRenameSpace: (from: string, to: string) => void;
  onRemoveSpace: (name: string) => void;
  onMoveSpace: (name: string, delta: number) => void;
  /// Owned by `App` for the reason the update channel is: the effect that acts
  /// on this lives there, and a second `useLocalStorage` copy here would write
  /// a value that effect never sees.
  autoHideSidebar: boolean;
  onAutoHideSidebarChange: (next: boolean) => void;
  /// Owned by `App`, because the issues page and the composer read it too.
  integrations: ReturnType<typeof useIntegrations>;
  /// The updater's state, owned by `App` — the sidebar's own `UpdateRow` draws
  /// the same fields, and a second copy of the hook would run its own check.
  updateStatus: UpdateStatus | null;
  updateManual: ManualCheck;
  /// A turn is in flight somewhere, so installing would kill a child mid-turn.
  updateBlocked: boolean;
  onCheckUpdates: () => void;
  onInstallUpdate: () => void;
  /// Owned by `useUpdater`, for the reason its own doc comment gives: a second
  /// `useLocalStorage` here would write a value the checking effect never sees.
  updateChannel: UpdateChannel;
  onUpdateChannelChange: (next: UpdateChannel) => void;
  /// Where the Accounts tab asks its questions: every probe runs here and the
  /// login terminal opens here, since a CLI resolves its own config against the
  /// directory it is started in.
  cwd: string;
}) {
  const { settings, setAnalyticsEnabled } = useAppSettings(open);
  const transcription = useTranscriptionSettings(open);

  if (!open) return null;

  return (
    <SettingsTabs initialTab={initialTab} onClose={onClose}>
      {{
        appearance: (
          <>
            <Section>
              <ThemeRow />
              <ModeRow />
            </Section>
            <Section>
              <ZoomRow />
            </Section>
            <Section>
              <AutoHideSidebarRow
                checked={autoHideSidebar}
                onChange={onAutoHideSidebarChange}
              />
            </Section>
          </>
        ),
        shortcuts: <ShortcutsSettings />,
        spaces: (
          <SpacesSettings
            projects={projects}
            spaces={spaces}
            startNaming={startNamingSpace}
            onSetProjectSpace={onSetProjectSpace}
            onRemoveProject={onRemoveProject}
            onCreateSpace={onCreateSpace}
            onRenameSpace={onRenameSpace}
            onRemoveSpace={onRemoveSpace}
            onMoveSpace={onMoveSpace}
          />
        ),
        accounts: <AccountsSettings cwd={cwd} />,
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
            <BrowserRow />
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
              <UpdatesRow
                status={updateStatus}
                manual={updateManual}
                blocked={updateBlocked}
                onCheck={onCheckUpdates}
                onInstall={onInstallUpdate}
              />
              <BetaUpdatesRow
                channel={updateChannel}
                onChange={onUpdateChannelChange}
              />
              <AnalyticsRow view={settings} onChange={setAnalyticsEnabled} />
            </Section>
            {/* The two blocks here with no label of their own, so they are the
                ones that still want a heading over them. */}
            <Section title="Support">
              <SupportBlock />
            </Section>
            <Section title="Feedback">
              <ContactBlock />
            </Section>
            <p className="text-ui text-muted-foreground">
              Made by{" "}
              <button
                type="button"
                onClick={() => void openUrl(CONTACT_URL)}
                className="cursor-pointer text-foreground underline-offset-4 hover:underline"
              >
                Yogesh
              </button>
            </p>
          </>
        ),
      }}
    </SettingsTabs>
  );
}

/// The chords only — zoom has no control of its own. It replaced the per-text
/// font sizes, so a reader who had set one and found it gone learns here
/// what stands in for it.
function ZoomRow() {
  const id = useId();
  useShortcutOverrides();
  const hints = (
    [
      ["In", "zoom.in"],
      ["Out", "zoom.out"],
      ["Reset", "zoom.reset"],
    ] as const
  ).filter(([, chord]) => chordFor(chord));
  return (
    <SettingRow
      id={id}
      asGroup
      label="Zoom"
      description="Makes text and everything else larger or smaller."
    >
      <span className="flex items-center gap-3 text-ui text-muted-foreground">
        {hints.map(([word, chord]) => (
          <span key={chord} className="flex items-center gap-1.5">
            {word} <ShortcutKeys ids={[chord]} />
          </span>
        ))}
      </span>
    </SettingRow>
  );
}

/// The palette, picked by looking at it — the swatches are [ThemeSwatches].
///
/// **The one row here with no description**, deliberately: the control is the
/// explanation. A sentence saying "the palette everything uses" next to two visible,
/// named palettes is words spent on something the reader has already seen.
///
/// [ThemeSwatches]: ./ThemeSwatches.tsx
function ThemeRow() {
  const id = useId();
  useShortcutOverrides();

  return (
    <SettingRow
      id={id}
      asGroup
      stacked
      label="Theme"
      // Gone with the chord: "Cycle" and no keys is a word pointing at nothing.
      trailing={
        chordFor("theme.next") && (
          <span className="flex items-center gap-1.5 text-ui text-muted-foreground">
            Cycle <ShortcutKeys ids={["theme.next"]} />
          </span>
        )
      }
    >
      <ThemeSwatches labelledBy={id} />
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
            className="justify-between font-normal"
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

        {/* Aligned to the end because the control sits at the page's right
            edge, where a start-aligned menu opens past it.

            Sized to the longest app name, floored at the trigger's own width.
            The default is the other way round — `w-(--radix-…-trigger-width)`
            pins the menu *to* the trigger — which is right for a control that
            fills its row and wrong for one that has shrunk to a single app
            name, where it made the menu narrower than its own items. */}
        <DropdownMenuContent
          align="end"
          className="w-auto min-w-(--radix-dropdown-menu-trigger-width)"
        >
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
/// resolve it to light. The selected segment reads `modeFor`, so it is honest about
/// what is rendering.
function ModeRow() {
  const id = useId();
  const { theme, mode: chosen, setMode } = useTheme();
  const available = hasLightMode(theme);
  // What is drawn: a dark-only theme shows Dark selected, while the reader's own
  // mode waits in the store for the next theme that can use it.
  const mode = modeFor(theme, chosen);

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
    >
      {/* On a dark-only theme the control gives way to the one fact, rather
          than three disabled segments under a sentence explaining them. The
          row stays, so the reader still learns why there is no light here. */}
      {!available ? (
        <p className="text-ui text-muted-foreground">This theme is dark only.</p>
      ) : (
      <div
        role="radiogroup"
        aria-labelledby={id}
        onKeyDown={onKeyDown}
        // Track and thumb, the way a segmented control reads everywhere: the
        // selected one is a raised card sitting *in* a recessed rail, so the
        // group says "one of these" before any label is read.
        className="inline-flex w-fit gap-0.5 rounded-lg bg-muted p-0.5"
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
            tabIndex={mode === value ? 0 : -1}
            onClick={() => setMode(value)}
            className={cn(
              "rounded-[calc(var(--radius)-4px)] px-3 py-1 text-ui transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              "cursor-pointer",
              mode === value
                ? "bg-card text-foreground shadow-2xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      )}
    </SettingRow>
  );
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
  /// the page, since the tab bodies are switched rather than hidden.
  const [confirming, setConfirming] = useState<UpdateChannel | null>(null);

  return (
    <SettingRow
      id={id}
      label="Beta updates"
      description="Get new versions early, before they're fully tested."
    >
      {confirming ? (
        // "Confirm", not the verb again — the button just pressed said that,
        // and the same word twice reads as the press not having landed.
        <CancelOrConfirm
          verb="Confirm"
          destructive={false}
          autoFocus
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            onChange(confirming);
            setConfirming(null);
          }}
        />
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

/// Check for updates, and install one that has already downloaded.
///
/// The same answer the menu item gives, in a place a collapsed sidebar cannot
/// take away — `UpdateRow` lives inside `<aside>`, so "Check for Updates…" had
/// nowhere to report to while the sidebar was shut.
///
/// **One button, and its label is the whole state.** Checking, up to date,
/// downloading and ready are four answers to one question, so a sentence under
/// the row would say a second time what the label already says — and the label
/// is where the reader is looking, having just pressed it. The verdicts retire
/// themselves after a few seconds, so the button settles back to the offer.
///
/// It draws whatever the updater is doing rather than only what this button
/// started: a background check that already found something leaves the row
/// offering the restart, which is the more useful of the two answers. A blocked
/// install takes `UpdateRow`'s treatment exactly — `aria-disabled` and a
/// tooltip, never `disabled`, which fires no pointer events to open one.
function UpdatesRow({
  status,
  manual,
  blocked,
  onCheck,
  onInstall,
}: {
  status: UpdateStatus | null;
  manual: ManualCheck;
  blocked: boolean;
  onCheck: () => void;
  onInstall: () => void;
}) {
  const id = useId();
  const ready = status?.state === "ready";
  const downloading = status?.state === "downloading";

  const label = ready
    ? `Restart to update (v${status.version})`
    : downloading
      ? `Downloading${status.percent === null ? "…" : ` ${status.percent}%`}`
      : manual === "checking"
        ? "Checking…"
        : manual === "up_to_date"
          ? "Up to date"
          : manual === "failed"
            ? "Couldn't check"
            : "Check for updates";

  const button = (
    <Button
      id={id}
      variant="outline"
      size="sm"
      // Only the install has a reason worth a tooltip, so only it gives up
      // `disabled` for the aria form. A download in flight is its own answer,
      // and the hook's in-flight guard would refuse a second check anyway.
      aria-disabled={ready && blocked}
      disabled={!ready && (manual === "checking" || downloading)}
      onClick={() => {
        if (!ready) return onCheck();
        if (!blocked) onInstall();
      }}
      className="aria-disabled:cursor-default aria-disabled:opacity-50"
    >
      {manual === "checking" && !ready && <Spinner className="size-3.5" />}
      {label}
    </Button>
  );

  // The same sentence the sidebar row draws, since this page covers it — a
  // reader who pressed the button here would otherwise get no answer at all.
  return (
    <SettingRow id={id} label="Updates" description={updateFailure(manual)}>
      {ready && blocked ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="top">
            Waiting for the running turn to finish.
          </TooltipContent>
        </Tooltip>
      ) : (
        button
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
          : // Says what is actually sent. It read "your conversations and
            // activity are never collected" while a launch was the only event,
            // and that stopped being true the moment features were reported —
            // a privacy line that overpromises is worse than no line. Errors
            // are named for the same reason, and named as *where*: what goes is
            // a stage or a `file:line`, never the message beside it.
            "Counts launches, which features get used, and where errors happen, under a random id. Your prompts, code and conversations are never collected."
      }
    >
      <Switch
        id={id}
        // `null` until the first read lands. Disabled rather than guessing a
        // value: either guess is wrong for somebody, and the page's own open
        // animation is longer than a local file read.
        disabled={view === null || view.analyticsLocked}
        checked={view?.analyticsEnabled ?? false}
        onCheckedChange={onChange}
      />
    </SettingRow>
  );
}

/// Whether the Browser view takes the sidebar with it. Appearance rather than
/// Integrations: the setting is about what the window does with its own chrome,
/// not about the browser.
function AutoHideSidebarRow({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const id = useId();

  return (
    <SettingRow
      id={id}
      // "Auto" carries what the sentence under it used to: the sidebar comes
      // back on its own on the way out.
      label="Auto-hide sidebar in Browser View"
    >
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </SettingRow>
  );
}

/// The in-app browser's Chromium: downloaded after install rather than shipped,
/// so this is where the reader sees it land, retries a failed fetch, or takes
/// the 300MB back. Nothing to draw in a build without the browser, where the
/// status read fails and stays `null`.
///
/// Remove asks twice in the row, the way the model list does — the file comes
/// back with one press, but only after a download the reader may not want
/// twice on a slow link.
function BrowserRow() {
  const id = useId();
  const status = useChromium();
  const [confirming, setConfirming] = useState(false);
  // Why the last Remove was refused — once CEF has loaded the framework the
  // answer is "quit and reopen", and a button that swallows that looks like
  // one that does nothing.
  const [error, setError] = useState<string | null>(null);

  if (!status) return null;

  return (
    <SettingRow
      id={id}
      label="Browser"
      description={
        error ? (
          <span className="text-destructive">{error}</span>
        ) : confirming ? (
          "Chromium will be downloaded again the next time Dray starts."
        ) : (
          describeChromium(status)
        )
      }
    >
      {chromiumBusy(status) ? (
        status.state === "downloading" ? (
          <span className="text-ui tabular-nums text-muted-foreground">
            {chromiumPercent(status)}%
          </span>
        ) : (
          <Spinner className="size-4 text-muted-foreground" />
        )
      ) : status.state === "ready" ? (
        confirming ? (
          <CancelOrConfirm
            verb="Remove"
            onCancel={() => {
              setConfirming(false);
              setError(null);
            }}
            onConfirm={async () => {
              try {
                await removeChromium();
                setConfirming(false);
                setError(null);
              } catch (e) {
                setError(String(e));
              }
            }}
          />
        ) : (
          <Button id={id} variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Remove
          </Button>
        )
      ) : (
        <Button id={id} variant="outline" size="sm" onClick={() => void downloadChromium()}>
          {status.state === "failed" ? "Retry" : "Download"}
        </Button>
      )}
    </SettingRow>
  );
}

/// The connected issue tracker — and **only** when there is one.
///
/// Connecting happens on the issues page, not here. That page is the surface
/// with nothing to show without a key, so it is where the field that fixes it
/// belongs; a second copy in this page would be a second form for one slot,
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
            <CancelOrConfirm
              verb="Disconnect"
              busy={busy}
              onCancel={() => setConfirming(false)}
              onConfirm={async () => {
                await disconnect();
                setConfirming(false);
              }}
            />
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
/// whole block. An issue leads, since a report there is one the next person with the
/// same bug can find; a message is for what an issue is too heavy for.
///
/// Both go through `openUrl` — the same route the PR panel and transcript links
/// take, so a link from here lands in the reader's own browser rather than turning
/// the app window into one.
function ContactBlock() {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-ui text-muted-foreground">
        Found a bug or want something? Open an issue on GitHub, or send a PR.
      </p>
      <div className="flex items-center gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => void openUrl(ISSUES_URL)}>
          Open an issue
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void openUrl(CONTACT_URL)}>
          Message me
        </Button>
      </div>
    </div>
  );
}

/// Sponsoring, starring, and who already did the first.
///
/// The list is written here and ships with a release — no fetch, so it cannot
/// fail, and a name added is a line in this file.
function SupportBlock() {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-ui text-muted-foreground">
        Dray is free and open source. Sponsoring or starring the repo keeps it going.
      </p>
      <div className="flex items-center gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => void openUrl(SPONSOR_URL)}>
          <Heart />
          Sponsor
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void openUrl(REPO_URL)}>
          <Star />
          Star on GitHub
        </Button>
      </div>
      <ul className="flex flex-col gap-1 pt-1">
        {SUPPORTERS.map((s) => (
          <li key={s.name}>
            <button
              type="button"
              onClick={() => void openUrl(s.url)}
              className="-mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
            >
              {s.avatar ? (
                <img src={s.avatar} alt="" className="size-7 shrink-0 rounded-full object-cover" />
              ) : (
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs text-muted-foreground">
                  {s.name[0]}
                </span>
              )}
              <span className="flex min-w-0 flex-col">
                <span className="text-ui font-medium">{s.name}</span>
                <span className="text-ui text-muted-foreground">{s.note}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/// A run of rows, optionally under a quiet heading.
///
/// The heading is the exception now that the groups are tabs: the tab's own
/// label already names what is below it, so a heading repeating it is a second
/// copy of one word. What still earns one is a block carrying no label of its
/// own, which is the support and feedback links and nothing else.
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

/// Set *and* order, so a group added later is one entry plus one body. Icons
/// are Heroicons' filled 16px set, drawn for small sizes, at the sidebar rows'
/// own 14px. No keyboard in heroicons, so Shortcuts takes the bolt.
const SETTINGS_TABS = [
  { id: "appearance", label: "Appearance", Icon: PaintBrushIcon },
  { id: "spaces", label: "Spaces", Icon: Square3Stack3DIcon },
  { id: "accounts", label: "Accounts", Icon: KeyIcon },
  { id: "transcription", label: "Transcription", Icon: MicrophoneIcon },
  { id: "integrations", label: "Integrations", Icon: PuzzlePieceIcon },
  { id: "shortcuts", label: "Shortcuts", Icon: BoltIcon },
  { id: "about", label: "About", Icon: InformationCircleIcon },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

/// A line under a tab's title saying what the tab is for. Accounts has one
/// because its harness switches change what the composer's picker offers,
/// which nothing on the page itself would show.
const TAB_SUBTITLES: Partial<Record<SettingsTab, string>> = {
  accounts: "Manage each harness's sign-in. Switch one off to hide it from the model picker.",
};

/// The page's groups as a list down the left, standing where the sidebar
/// stands, with the picked group filling the rest of the window.
///
/// **About holds privacy and feedback**, which is the one grouping worth
/// arguing about. Both answer what the app does with you rather than what it
/// does for you: what is collected, and how to reach the person who wrote it.
/// Privacy alone was too thin to be a tab and reads oddly next to Appearance.
///
/// Bodies are switched, not hidden, unlike the right panel's. There is no
/// scroll position or expensive render to preserve here, and mounting them all
/// would have the external-app scan run on every open whichever tab the reader
/// wanted. The pick resets on close, since this only mounts while open.
function SettingsTabs({
  initialTab,
  onClose,
  children,
}: {
  initialTab: SettingsTab;
  onClose: () => void;
  children: Record<SettingsTab, ReactNode>;
}) {
  const id = useId();
  const fullscreen = useFullscreen();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  // State rather than a ref, since a portal needs the node during render and a
  // ref holds nothing on the first one.
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  const index = SETTINGS_TABS.findIndex((t) => t.id === tab);
  const { refs, onKeyDown } = useRovingGroup(SETTINGS_TABS.length, index, (next) =>
    setTab(SETTINGS_TABS[next].id),
  );

  // Focus lands on the picked group, so the arrows work at once and nothing
  // behind the page keeps it.
  useEffect(() => refs.current[index]?.focus(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // On the document, so Escape leaves from wherever focus is, body included.
  // Anything inside that answers Escape itself — a menu, the chord recorder,
  // the space name field — marks the event handled first, and keeps it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Handled, or WebKit passes the key on to the window, and Escape is
      // how macOS leaves fullscreen.
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* The sidebar's own width, border and titlebar strip, so the page
          reads as the sidebar changing what it lists rather than as a second
          window. */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border">
        {/* The way back sits where the gear that opened this sits: the
            strip's inner end, clearing the traffic lights, and the free left
            edge in fullscreen where they are gone. */}
        <div
          className={cn(
            "flex h-(--titlebar-h) shrink-0 items-center px-2",
            fullscreen ? "justify-start" : "justify-end",
          )}
          data-tauri-drag-region="deep"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Back"
                onClick={onClose}
                className="opacity-80 transition-opacity hover:opacity-100"
              >
                <ArrowLeft className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              Back
              <Kbd>Esc</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="px-2">
          <div
            role="tablist"
            aria-label="Settings"
            aria-orientation="vertical"
            onKeyDown={onKeyDown}
            className="flex flex-col gap-px"
          >
            {SETTINGS_TABS.map(({ id: value, label, Icon }, i) => (
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
                className="flex h-7 cursor-pointer items-center gap-1.5 px-1.5 text-left"
              >
                <Icon className="size-3.5 shrink-0" />
                {label}
              </TabButton>
            ))}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The app header's height and muted stand-in word, but the content's own
            `px-8`, so "Settings" and the tab title start on one edge. */}
        <header
          className="flex h-(--titlebar-h) shrink-0 items-center gap-2 overflow-hidden px-8"
          data-tauri-drag-region="deep"
        >
          <span className="text-ui text-muted-foreground">Settings</span>
        </header>
        {/* The scroll box spans the column so the bar sits at the window's
            edge; the text inside is capped, since a row stretched across a
            wide window leaves its label and its switch a screen apart.
            `shrink-0` on the sections, since a column flex item shrinks toward
            its content before the container agrees to scroll. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex w-full max-w-160 flex-col gap-7 px-8 pt-4 pb-16 [&>*]:shrink-0">
            {/* A tab hangs a header action here through a portal. The slot is
                `contents`, so what lands in it lays out in this row — an action
                takes `ml-auto` to the far end, a back arrow `-order-1` to lead
                the title. */}
            {/* One block with its subtitle, so the line reads as the title's
                rather than taking the column's gap like a section of its own. */}
            <div className="flex flex-col gap-1">
              <div className="flex h-7 items-center gap-2">
                <h1 className="text-base font-medium">{SETTINGS_TABS[index].label}</h1>
                <div ref={setSlot} className="contents" />
              </div>
              {TAB_SUBTITLES[tab] && (
                <p className="text-ui text-muted-foreground">{TAB_SUBTITLES[tab]}</p>
              )}
            </div>
            <div
              role="tabpanel"
              id={`${id}-panel`}
              aria-labelledby={`${id}-${tab}`}
              className="flex flex-col gap-7 [&>*]:shrink-0"
            >
              <SettingsHeaderSlot.Provider value={slot}>{children[tab]}</SettingsHeaderSlot.Provider>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/// Label and control on the top line, reason at full width underneath — and
/// `stacked` for when even that is the wrong shape.
///
/// Side by side was the first shape, and it broke on the widest control here: two
/// buttons pushed the sentence into a third of the page, where four words took
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
  trailing,
  children,
}: {
  id: string;
  label: string;
  /// A node, not a string: a row whose reason is best said with a mark beside
  /// it should not have to reach past this for the privilege.
  description?: ReactNode;
  asGroup?: boolean;
  stacked?: boolean;
  /// Drawn at the far end of a stacked row's label line — a hint about the
  /// control, such as the chord that cycles it.
  trailing?: ReactNode;
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
          <div className="flex items-center justify-between gap-4">
            {labelEl}
            {trailing}
          </div>
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
