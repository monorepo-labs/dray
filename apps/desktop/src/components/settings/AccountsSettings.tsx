import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  MoreHorizontal,
  Plus,
  RefreshCw,
  SquareTerminal,
} from "lucide-react";

import AgentIcon from "@/components/AgentIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { inputClassName } from "@/components/ui/input";
import Spinner from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import SettingsHeaderAction from "@/components/settings/headerAction";
import { useAgentAccounts, useAuthOptions } from "@/hooks/useAgentAccounts";
import { useAgentAvailability } from "@/hooks/useAgentAvailability";
import { cn } from "@/lib/utils";
import type { Account, AccountState, AgentAccounts, Harness } from "@/types/events";

const COPIED_MS = 1600;

/// What each state is called, in the reader's words rather than the wire's.
///
/// "Not signed in" over "logged out", which reads as something that happened to
/// them — a credential that was never added and one that expired are the same
/// row here, since both are fixed the same way and neither CLI says which.
const STATE_LABELS: Record<AccountState, string> = {
  logged_in: "Signed in",
  logged_out: "Not signed in",
  unknown: "Couldn't tell",
};

/// Which harnesses have something to *add* rather than only something to change.
///
/// pi alone, and it is about whether the providers can be *listed* rather than
/// how many credentials the CLI holds. Claude and Codex hold one each: signing
/// in again replaces it, which is the ⋯ menu's "change sign-in method" and not
/// an addition. fx holds three and every one of them is already a row, signed
/// in or not — so Add opened a form to reach a provider the reader could sign
/// into from the row in front of them. pi publishes no provider list at all,
/// which is what leaves a name only the reader can supply.
const MULTI_ACCOUNT: Harness[] = ["pi"];

/// The picker row that swaps the list for a text field. Not a provider id, and
/// it never reaches Rust: `effectiveProvider` resolves it to whatever was typed.
const CUSTOM_PROVIDER = "__custom__";

/// The dot beside a row, and the one place this page spends colour.
///
/// Green and grey, with the sidebar's yellow for the third state — which earns
/// a colour of its own precisely because it is *not* the absence of a
/// credential: a probe that could not run drawn in grey would read as "signed
/// out", which is the wrong thing to send a reader off to fix. The pair is the
/// sidebar rail's own, so a dot here reads the way the rows over there already
/// do rather than as two new literals.
function StateDot({ state }: { state: AccountState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state === "logged_in" && "bg-accent-add",
        state === "logged_out" && "bg-muted-foreground/40",
        state === "unknown" && "bg-accent-command",
      )}
    />
  );
}

/// The command an interactive sign-in takes: a button that runs it, and a copy
/// for the reader who would rather take it somewhere else.
///
/// **Dray opens the terminal and runs it**, which reverses this tab's first
/// shape. Showing the string beside a terminal opened at the working directory
/// was the careful reading — macOS lets no app type into another's prompt — but
/// what it asked of somebody who had just pressed Sign in was to copy a
/// command, find the window that had opened and paste it. The `.command` script
/// route needs no Accessibility grant at all, so the caution was about a
/// permission that was never involved.
///
/// The cost is stated and accepted: such a file is run by **Terminal.app
/// alone** — measured, with Ghostty and Warp accepting the open and running
/// nothing — so the terminal picked next door is not honoured here. That pick
/// still stands for opening a *directory*, which is all the table behind it
/// promises, and the copy button is what serves anybody who wants this
/// elsewhere.
///
/// The chip is pinned to `h-6` with a `size-5` copy inside it so it matches the
/// button beside it: its own `py-1` around a `size-6` button comes to 34px
/// where a small button draws at 26.
function CommandRow({
  command,
  onRun,
  busy,
}: {
  command: string;
  onRun: () => void;
  busy: boolean;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-border pr-0.5 pl-2 dark:border-input">
        <code className="font-mono text-code text-foreground">{command}</code>
        <button
          type="button"
          aria-label={`Copy ${command}`}
          onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true))}
          className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onRun}>
        <SquareTerminal className="size-3.5" />
        Run in Terminal
      </Button>
    </div>
  );
}

/// One credential, and nothing but what is true about it.
///
/// **The row reads and does not act**, which is the whole of what makes four
/// differently-capable CLIs draw as one list. Every route in is the form and
/// every route out is the ⋯ menu, so a row whose CLI happens to have no key
/// path is not a differently-shaped row — it is the same row, and the
/// difference shows up where the reader went looking for it.
function AccountRow({
  account,
  busy,
  confirming,
  onChange,
  onAskSignOut,
  onCancelSignOut,
  onSignOut,
}: {
  account: Account;
  busy: boolean;
  /// Whether this row is the one asking. Held by the parent rather than here,
  /// the reading the transcription rows already take: one press should leave
  /// one question on screen, not one per row that has ever been pressed.
  confirming: boolean;
  onChange: () => void;
  onAskSignOut: () => void;
  onCancelSignOut: () => void;
  onSignOut: () => void;
}) {
  const signedIn = account.state === "logged_in";
  // Signed in: how and who, in that order, and nothing where neither is known.
  // Otherwise the reason, which is the one thing the dot cannot carry.
  const subtext = signedIn
    ? [account.authType, account.detail].filter(Boolean).join(" · ")
    : (account.detail ?? STATE_LABELS[account.state]);

  return (
    <div className="flex items-center gap-3 py-1.5">
      <StateDot state={account.state} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-ui text-foreground">{account.label}</p>
        {/* **How, then who** — "Claude subscription · you@example.com · max".
            The auth type had a column of its own on the right and the subtext
            said "Signed in", which spent the one useful line restating the
            green dot and put the answer somewhere else. Drawn only where there
            is something to say: a row with no method and no identity is a name
            and a lit dot, which is the whole of what is known about it, and a
            line under it would be there to be filled rather than to be read.
            A signed-*out* row keeps its sentence, since the reason is the one
            thing the dot cannot carry. */}
        {subtext && <p className="truncate text-ui text-muted-foreground">{subtext}</p>}
      </div>

      {/* Asked in the row, not in a dialog — a modal over the whole window for
          a credential the reader can put back is more than the question is
          worth, and it is the reading the transcription rows already take.
          Nothing is undoable here, but every one of these is a sign-in away.

          It is a question because the menu item next to Reauthorize *was*
          undoable and this one is not: one slip sent `codex logout` with
          nothing between the press and the credential. */}
      {confirming ? (
        <div className="flex items-center gap-1">
          <span className="text-ui text-muted-foreground">Sign out?</span>
          <Button variant="ghost" size="sm" onClick={onCancelSignOut}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      ) : /* A row with nothing signed in has exactly one thing to offer, and
             `can_sign_out` follows being signed in on every harness — so its
             menu was one item behind a caret, which is a button with a step in
             front of it. The action is drawn on the row instead, and the menu
             is kept for the signed-in half, where there are genuinely two. */
      !signedIn ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={onChange}>
          Sign in
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-label={`${account.label} options`}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          {/* Wide enough for the longest item to stay on one line: the menu's
              own width is its trigger's, and a ⋯ button is 28px, so "Change
              sign-in method" wrapped over two. */}
          <DropdownMenuContent align="end" className="min-w-48">
            {/* Two wordings, and the second is the fix: with a single method
                there is nothing to *change*, so fx's Codex and Grok rows — a
                subscription and nothing else — offered an action the form could
                not carry out. Reauthorize is what one method allows, and it is
                also the answer for a credential that has quietly gone stale. */}
            <DropdownMenuItem onSelect={onChange}>
              {account.canChangeMethod ? "Change sign-in method" : "Reauthorize"}
            </DropdownMenuItem>
            {/* Absent rather than disabled where the CLI has no non-interactive
                sign-out: a greyed item invites a hover for a reason there is
                nowhere to put. */}
            {account.canSignOut && (
              <DropdownMenuItem variant="destructive" onSelect={onAskSignOut}>
                Sign out
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/// A labelled dropdown over a fixed list.
function Picker({
  label,
  value,
  placeholder,
  items,
  onPick,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  items: { id: string; label: string }[];
  onPick: (id: string) => void;
}) {
  const current = items.find((item) => item.id === value);

  return (
    <label className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-ui text-muted-foreground">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" className="min-w-0 flex-1 justify-between">
            <span className={cn("truncate", !current && "text-muted-foreground")}>
              {current?.label ?? placeholder}
            </span>
            <ChevronDown className="size-3.5 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
          {items.map((item) => (
            <DropdownMenuItem key={item.id} onSelect={() => onPick(item.id)}>
              {item.id === value && <Check className="size-3.5" />}
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </label>
  );
}

/// Signing one credential in: which provider, and by what method.
///
/// **One form for every agent**, which is what per-agent buttons were costing.
/// The differences are all answers Rust gives — which providers exist, which
/// methods *this provider* has, whether a method takes a key here or a command
/// the reader runs — so the form asks the same questions every time and the
/// answers change underneath.
///
/// It replaces the list rather than opening a dialog: a modal over a modal is a
/// second Escape to learn, and there is nothing on the list worth seeing while
/// the form is up.
function SignInForm({
  agent,
  busy,
  initialProvider,
  /// The method this credential is already on, where it has one. Preselected,
  /// so "change sign-in method" opens showing what is in use rather than asking
  /// the reader to work out which row they are already on — and it is what
  /// turns the submit into *Reauthorize*, since picking the method you already
  /// have is not a change.
  currentAuth,
  reauth,
  cwd,
  onDone,
  onSubmit,
}: {
  agent: AgentAccounts;
  busy: boolean;
  initialProvider: string | null;
  currentAuth: string | null;
  /// Redoing a credential already in place, as the row that opened this said.
  reauth: boolean;
  cwd: string;
  onDone: () => void;
  onSubmit: (
    harness: Harness,
    provider: string | null,
    auth: string,
    key: string | null,
  ) => Promise<boolean>;
}) {
  const [provider, setProvider] = useState<string | null>(initialProvider);
  const [typed, setTyped] = useState("");
  const [auth, setAuth] = useState<string | null>(currentAuth);
  const [key, setKey] = useState("");
  // The terminal route's own two bits of state. Separate from the page's
  // `busy`, which is about the probes: opening a terminal neither reads nor
  // writes a credential, so it must not disable the list behind it.
  const [running, setRunning] = useState(false);
  const [runFailed, setRunFailed] = useState<string | null>(null);

  const needsProvider = agent.providers.length > 0;
  // A row in the list rather than a field standing open beside it. The field
  // was drawn always, which put two ways to answer one question on screen at
  // once and left a reader who had picked from the menu looking at an empty box
  // asking them to pick again.
  const custom = provider === CUSTOM_PROVIDER;
  const effectiveProvider = custom ? typed.trim() || null : provider;
  const options = useAuthOptions(agent.harness, effectiveProvider);
  const picked = options.find((option) => option.id === auth) ?? null;

  // pi's methods are per provider — six of its providers have OAuth and one has
  // only that — so changing provider can strand a pick that is no longer
  // offered. Falls back to the current method where it survives, then to the
  // only option where there is one: a list of one is not a choice, and making
  // the reader click it is a step that asks nothing.
  useEffect(() => {
    setAuth((current) => {
      if (options.some((option) => option.id === current)) return current;
      if (options.some((option) => option.id === currentAuth)) return currentAuth;
      return options.length === 1 ? options[0].id : null;
    });
  }, [options, currentAuth]);

  const ready =
    picked && (!needsProvider || !!effectiveProvider) && (!picked.needsKey || key.trim().length > 0);
  // Reauthorizing is doing again what is already in place — a token that
  // expired, an account that changed underneath. Saying "sign in" there reads
  // as offering a second account the CLI cannot hold. Moving *off* the method
  // in use is a change rather than a redo, so the pick narrows it; a row whose
  // CLI names no method at all (every fx one) keeps the row's own word.
  const again = reauth && (!currentAuth || currentAuth === picked?.id);

  return (
    <form
      // `mt-6` because this card is the panel's only child and the panel starts
      // at the dialog's top edge: without it the card's own top corner runs
      // under the close cross, which is absolute against the dialog and sits
      // outside every layout in here.
      className="mt-6 flex flex-col gap-3 rounded-xl border border-border/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || !picked?.needsKey) return;
        void onSubmit(agent.harness, effectiveProvider, picked.id, key).then(
          (took) => took && onDone(),
        );
      }}
    >
      {/* No control of its own on this row: leaving is a back arrow up in the
          dialog's header, level with the close cross, where the reader already
          looks to get out of something. A cross here said "close" a few pixels
          from the one that closes the dialog. */}
      <span className="flex items-center gap-2 text-ui font-medium">
        <AgentIcon harness={agent.harness} className="size-4 text-muted-foreground" />
        {again ? "Reauthorize" : "Sign in to"} {agent.label}
      </span>

      {needsProvider && (
        <>
          <Picker
            label="Provider"
            value={provider}
            placeholder="Pick a provider"
            // pi's list is a seed rather than the whole truth — it publishes
            // none — so Custom is what lets the reader name one nobody here
            // listed, with pi itself deciding whether it exists. Without it a
            // provider pi gained after this build would be unreachable.
            items={
              agent.providerFreeform
                ? [...agent.providers, { id: CUSTOM_PROVIDER, label: "Custom…" }]
                : agent.providers
            }
            onPick={setProvider}
          />
          {custom && (
            <label className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-ui text-muted-foreground">Name</span>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="as pi spells it — openrouter, moonshotai"
                aria-label="Provider name"
                className={cn(inputClassName, "min-w-0 flex-1")}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </label>
          )}
        </>
      )}

      {/* The method, and the reason this page was confusing before it existed:
          "paste a key" and "sign in with the provider" are the same question
          asked once, not a field on some rows and a button on others. A
          radiogroup rather than another dropdown, since the hints under each
          are the whole point — one of them is about how the reader gets
          billed. Drawn only where there is more than one: a group of one is a
          control that asks nothing. */}
      {options.length > 1 && (
        <div className="flex gap-3">
          <span className="w-20 shrink-0 pt-1.5 text-ui text-muted-foreground">Method</span>
          <div role="radiogroup" aria-label="Sign-in method" className="flex min-w-0 flex-1 flex-col gap-1">
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={option.id === auth}
                onClick={() => setAuth(option.id)}
                className={cn(
                  "flex items-start gap-2 rounded-lg px-2 py-1.5 text-left",
                  option.id === auth ? "bg-muted" : "hover:bg-muted/50",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 size-3 shrink-0 rounded-full border",
                    option.id === auth ? "border-[4px] border-foreground" : "border-border",
                  )}
                />
                <span className="min-w-0">
                  <span className="block text-ui text-foreground">
                    {option.label}
                    {/* Which one is already in use, said on the row rather than
                        left to the radio alone — a preselected dot says "this
                        is picked", not "this is what you have". */}
                    {option.id === currentAuth && (
                      <span className="text-muted-foreground"> · in use</span>
                    )}
                  </span>
                  {option.hint && (
                    <span className="block text-ui text-muted-foreground">{option.hint}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The field appears with the method that takes one, so a key can never
          be typed into a form that is really a command to copy. */}
      {picked?.needsKey && (
        <label className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-ui text-muted-foreground">Key</span>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={`Stored by ${agent.label}, not by Dray`}
            aria-label="API key"
            className={cn(inputClassName, "min-w-0 flex-1")}
            // A credential field, and a password manager filling or keeping it
            // is the one thing this form promises not to do.
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      )}

      {/* A command route ends at its own button rather than at the form's: the
          sign-in happens over in the terminal, so there is nothing here to
          Save. The reader comes back to Refresh once it has landed. */}
      {picked && !picked.needsKey && (
        <div className="flex gap-3">
          <span className="w-20 shrink-0 pt-1.5 text-ui text-muted-foreground">Run</span>
          <div className="min-w-0 flex-1">
            <CommandRow
              command={picked.command ?? ""}
              busy={running}
              onRun={() => {
                setRunFailed(null);
                setRunning(true);
                void invoke("run_agent_login", {
                  harness: agent.harness,
                  provider: effectiveProvider,
                  auth: picked.id,
                  cwd,
                })
                  .catch((err) => setRunFailed(String(err)))
                  .finally(() => setRunning(false));
              }}
            />
            {runFailed && <p className="pt-1.5 text-ui text-destructive">{runFailed}</p>}
          </div>
        </div>
      )}

      {picked?.needsKey && (
        <div className="flex items-center justify-end gap-2">
          <Button type="submit" variant="secondary" size="sm" disabled={!ready || busy}>
            {again ? "Reauthorize" : "Save"}
          </Button>
        </div>
      )}
    </form>
  );
}

/// An agent with no CLI behind it: the one row that is about the machine rather
/// than about an account.
function MissingAgent({ agent }: { agent: AgentAccounts }) {
  const [copied, setCopied] = useState(false);
  const availability = useAgentAvailability()?.find((a) => a.harness === agent.harness);
  const installCommand = availability?.installCommand;
  const docsUrl = availability?.docsUrl;

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex items-center gap-3 py-1.5">
      <StateDot state="logged_out" />
      <p className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
        {availability?.reason ?? `${agent.label} isn't installed.`}
      </p>
      {installCommand && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(installCommand).then(() => setCopied(true))
          }
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy install"}
        </Button>
      )}
      {docsUrl && (
        <Button variant="ghost" size="sm" onClick={() => void openUrl(docsUrl)}>
          <ExternalLink className="size-3.5" />
          Guide
        </Button>
      )}
    </div>
  );
}

/// Which account each agent runs as, and how to change it.
///
/// **Reported before a turn needs it, which is the whole point.** The same
/// facts already reach the composer as [LoginExpiredNotice] — but only *after*
/// a turn has failed on auth, and never for a session that is working fine, so
/// "which account is this running as" had nowhere to be asked.
///
/// **Rows read; one form writes.** The four CLIs differ in what they can do
/// without a terminal — Codex takes a key on stdin, pi's store is a file Dray
/// writes, everything else is a command — and letting each row wear its own
/// capability made four differently-shaped blocks out of one list. So every row
/// is status plus a ⋯ menu, and every way *in* is the one form.
///
/// **Dray runs no sign-in command and stores no credential.** A pasted key goes
/// to the CLI's own store; everything else is a command shown with a copy on it
/// beside the reader's own terminal. macOS lets no app type into another's
/// prompt, so anything else would be Dray deciding what to execute in their
/// shell.
export default function AccountsSettings({
  cwd,
}: {
  /// Where the terminal button opens. The selected session's directory where
  /// there is one. A courtesy, and the whole of what the directory decides: all
  /// four stores live under the reader's home, so a sign-in run in one tree is
  /// a sign-in everywhere.
  cwd: string;
}) {
  // Owned here rather than in `App`, unlike the issue tracker's, and the
  // dialog's own bargain is what makes that safe: bodies are *switched*, not
  // hidden, so this component exists only while its tab is the one on screen —
  // which is the gate. Four child processes on every settings open, whichever
  // tab the reader wanted, is the cost the external-app scan next door is
  // deliberately not paying either.
  const { agents, busy, error, refresh, addAccount, signOut } = useAgentAccounts(cwd);
  const [signingIn, setSigningIn] = useState<{
    harness: Harness;
    provider: string | null;
    currentAuth: string | null;
    /// Whether this is redoing a credential already in place, decided by the
    /// row that opened the form rather than inferred inside it. Inferred from
    /// "the picked method is the one in use" it read false wherever the CLI
    /// reports no method at all — every fx row — so a reauthorize there
    /// announced itself as a fresh sign-in.
    reauth: boolean;
  } | null>(null);
  // Which row is asking "sign out?", as one id rather than a flag per row: one
  // press should leave one question on screen. `harness:provider`, since a
  // provider name alone repeats across harnesses.
  const [confirming, setConfirming] = useState<string | null>(null);

  const agent = agents?.find((a) => a.harness === signingIn?.harness) ?? null;

  return (
    <div className="flex flex-col gap-5">
      {/* No preamble. A paragraph here explained *Dray's* constraints — which
          CLI can be driven headlessly and which cannot — to a reader who came
          to see which account they are on. Both facts are already said where
          they are true: the command row shows what to run, and the key field
          says whose store it lands in. */}
      {/* Refresh is not a convenience. Nothing comes back from a terminal, so
          after a sign-in the page's own read is the only way it learns. Nothing
          polls instead: a sign-in can take a browser round trip, and four
          children on a timer to catch it is worse than a button.

          Up in the dialog's header rather than down here, and a glyph rather
          than a word: it acts on the whole tab, not on the rows nearest it, and
          a row of its own pushed every account down the page and scrolled away
          the moment the reader went looking for it. The name it loses off its
          face it keeps in a real tooltip and in `aria-label`.

          The form takes the strip over instead: a back arrow leading it, level
          with the close cross, where a reader already looks to get out of
          something. Refresh has nothing to re-read while a credential is being
          written, and the two would have sat a few pixels apart meaning
          different kinds of "leave". */}
      <SettingsHeaderAction>
        {signingIn ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            className="mr-auto"
            onClick={() => setSigningIn(null)}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh"
                disabled={busy}
                onClick={() => void refresh()}
              >
                {busy ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        )}
      </SettingsHeaderAction>

      {error && <p className="text-ui text-destructive">{error}</p>}

      {agents === null ? (
        // The probes spawn four children, so the first open has a real wait in
        // it. A spinner rather than empty rows: an empty list here would read
        // as "no agent is signed in", which is a claim rather than a delay.
        // It says what is being waited for, not how — "Asking each agent" was
        // Dray describing its own four children to somebody who came to read
        // one list.
        <div className="flex items-center gap-2 py-4 text-ui text-muted-foreground">
          <Spinner className="size-3.5" />
          Loading accounts&hellip;
        </div>
      ) : agent && signingIn ? (
        <SignInForm
          agent={agent}
          busy={busy}
          initialProvider={signingIn.provider}
          currentAuth={signingIn.currentAuth}
          reauth={signingIn.reauth}
          cwd={cwd}
          onSubmit={addAccount}
          onDone={() => setSigningIn(null)}
        />
      ) : (
        agents.map((agent) => {
          // pi's rows are the providers it is *configured* for, and its own
          // list is a seed rather than a catalogue — a name this build never
          // heard of is still one `pi auth check` can answer for, so there is
          // always something left to add. fx used to count unsigned providers
          // here; with all three drawn as rows there is nothing for the count
          // to gate.
          const canAdd = agent.installed && MULTI_ACCOUNT.includes(agent.harness);

          return (
            <div key={agent.harness} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <AgentIcon harness={agent.harness} className="size-4 text-muted-foreground" />
                <span className="text-ui font-medium">{agent.label}</span>
              </div>

              {!agent.installed ? (
                <MissingAgent agent={agent} />
              ) : (
                <>
                  {agent.accounts.map((account) => {
                    const id = `${agent.harness}:${account.provider ?? ""}`;
                    return (
                      <AccountRow
                        key={account.provider ?? account.label}
                        account={account}
                        busy={busy}
                        confirming={confirming === id}
                        onChange={() => {
                          setConfirming(null);
                          setSigningIn({
                            harness: agent.harness,
                            provider: account.provider,
                            // The method in use, matched back to the option id
                            // it came from — the row carries a label ("OAuth")
                            // where the form picks by id ("oauth").
                            currentAuth: authIdOf(account.authType),
                            reauth: account.state === "logged_in",
                          });
                        }}
                        onAskSignOut={() => setConfirming(id)}
                        onCancelSignOut={() => setConfirming(null)}
                        onSignOut={() => {
                          setConfirming(null);
                          void signOut(agent.harness, account.provider);
                        }}
                      />
                    );
                  })}

                  {/* Installed, and nothing to show. pi is the case: its rows
                      come from the model list, so a pi nobody has signed into
                      anywhere names none. */}
                  {agent.accounts.length === 0 && (
                    <div className="flex items-center gap-3 py-1.5">
                      <StateDot state="logged_out" />
                      <p className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
                        {agent.error ?? "No account signed in."}
                      </p>
                    </div>
                  )}

                  {agent.error && agent.accounts.length > 0 && (
                    <p className="text-ui text-destructive">{agent.error}</p>
                  )}

                  {canAdd && (
                    <div className="pt-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setSigningIn({
                            harness: agent.harness,
                            provider: null,
                            currentAuth: null,
                            reauth: false,
                          })
                        }
                      >
                        <Plus className="size-3.5" />
                        Add an account
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

/// The option id behind the method a row reports.
///
/// The two are stated separately on purpose — a row says what the *CLI* calls
/// its credential, the form picks between ids `add_account` accepts — so this
/// is the one place they are joined, and an unrecognised label answers `null`
/// rather than guessing. `null` costs the preselection and nothing else: the
/// form opens with no method picked, which is where it was before.
function authIdOf(authType: string | null): string | null {
  switch (authType) {
    case "Claude subscription":
      return "claudeai";
    case "Anthropic Console":
      return "console";
    case "ChatGPT subscription":
      return "chatgpt";
    case "OpenAI API key":
      return "api_key";
    case "OAuth":
      return "oauth";
    case "API key":
      return "api_key";
    default:
      return null;
  }
}
