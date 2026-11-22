import { useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ChevronDown, Copy, ExternalLink } from "lucide-react";

import AgentIcon from "@/components/AgentIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import Spinner from "@/components/ui/spinner";
import { useAgentAccounts, useAuthOptions } from "@/hooks/useAgentAccounts";
import { useAgentAvailability } from "@/hooks/useAgentAvailability";
import { useCopied } from "@/hooks/useCopied";
import { onFocusChange } from "@/lib/focus";
import { AGENT_LABELS, HARNESS_ORDER } from "@/lib/model";
import { invoke, LOCAL } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { Harness } from "@/types/events";

export type SetupState = "checking" | "ready" | "signin" | "install";

export type SetupRow = {
  harness: Harness;
  label: string;
  state: SetupState;
  /// Who it is signed in as, where the CLI says.
  detail: string | null;
  installCommand: string | null;
  docsUrl: string | null;
};

export type AgentSetup = { rows: SetupRow[]; ready: SetupRow[]; checking: boolean };

/// Every agent on this Mac, read the way the Accounts tab reads them, and read
/// again whenever the window comes back from a Terminal sign-in.
export function useAgentSetup(): AgentSetup {
  const { agents, refresh } = useAgentAccounts("", LOCAL);
  const availability = useAgentAvailability(LOCAL);
  useEffect(() => onFocusChange((focused) => focused && void refresh()), [refresh]);

  const rows = HARNESS_ORDER.map((harness): SetupRow => {
    const agent = agents?.find((a) => a.harness === harness);
    const avail = availability?.find((a) => a.harness === harness);
    const signedIn = agent?.accounts.find((a) => a.state === "logged_in");
    return {
      harness,
      label: agent?.label ?? AGENT_LABELS[harness],
      state: !agent ? "checking" : !agent.installed ? "install" : signedIn ? "ready" : "signin",
      detail: signedIn?.detail ?? null,
      installCommand: avail?.installCommand ?? null,
      docsUrl: avail?.docsUrl ?? null,
    };
  });
  return { rows, ready: rows.filter((r) => r.state === "ready"), checking: agents === null };
}

const STATE_TEXT: Record<SetupState, string> = {
  checking: "Checking…",
  ready: "Ready",
  signin: "Not signed in",
  install: "Not installed",
};

export function StateLine({ row, className }: { row: SetupRow; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-ui text-muted-foreground", className)}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          row.state === "ready" ? "bg-accent-add" : "bg-muted-foreground/40",
        )}
      />
      <span className="truncate">{row.state === "ready" && row.detail ? row.detail : STATE_TEXT[row.state]}</span>
    </span>
  );
}

/// The one thing to do about an agent: install it, sign it in, or nothing.
/// `onMore` opens Settings → Agents, which holds the key and provider forms.
export function AgentAction({ row, onMore }: { row: SetupRow; onMore: () => void }) {
  if (row.state === "checking") return <Spinner className="size-3.5 text-muted-foreground" />;
  if (row.state === "ready") return <Check aria-label="Ready" className="size-4 text-accent-add" />;
  if (row.state === "install") return <InstallAction row={row} />;
  return <SignInAction row={row} onMore={onMore} />;
}

function InstallAction({ row }: { row: SetupRow }) {
  const [copied, copy] = useCopied();
  if (!row.installCommand) return null;
  return (
    <span className="flex items-center gap-0.5">
      <Button variant="secondary" size="sm" onClick={() => void copy(row.installCommand!)}>
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy install"}
      </Button>
      {row.docsUrl && (
        <Button variant="ghost" size="icon-sm" aria-label="Install guide" onClick={() => void openUrl(row.docsUrl!)}>
          <ExternalLink />
        </Button>
      )}
    </span>
  );
}

function SignInAction({ row, onMore }: { row: SetupRow; onMore: () => void }) {
  const options = useAuthOptions(row.harness, null, LOCAL).filter((o) => o.command);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm">
          Sign in
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-72">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.id}
            className="flex-col items-start gap-0"
            onSelect={() =>
              void invoke("run_agent_login", { harness: row.harness, provider: null, auth: option.id, cwd: "" }, LOCAL).catch(
                (err) => console.error("sign-in", err),
              )
            }
          >
            <span>{option.label}</span>
            {option.hint && <span className="text-xs text-muted-foreground">{option.hint}</span>}
          </DropdownMenuItem>
        ))}
        {options.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={onMore}>Other ways…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/// Every agent as a compact row: face, name, state, action.
export function AgentList({ setup, onMore, className }: { setup: AgentSetup; onMore: () => void; className?: string }) {
  return (
    <ul className={cn("flex flex-col", className)}>
      {setup.rows.map((row) => (
        <li key={row.harness} className="flex h-10 items-center gap-2.5">
          <AgentIcon harness={row.harness} brand className="size-4 shrink-0" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-ui leading-tight font-medium">{row.label}</span>
            <StateLine row={row} className="text-xs leading-tight" />
          </span>
          <AgentAction row={row} onMore={onMore} />
        </li>
      ))}
    </ul>
  );
}
