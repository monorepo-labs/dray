import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Plus, RefreshCw, Trash2 } from "lucide-react";

import AgentIcon from "@/components/AgentIcon";
import { ServerPicker } from "@/components/settings/AccountsSettings";
import { CancelOrConfirm } from "@/components/settings/InRowConfirm";
import SettingsHeaderAction from "@/components/settings/headerAction";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Spinner from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  loadAcpAgents,
  removeCustomAcpAgent,
  saveCustomAcpAgent,
  setAcpAgentEnabled,
  useAcpAgents,
} from "@/lib/acpAgents";
import { useServers } from "@/lib/servers";
import { LOCAL, serverOfPath, type ServerId } from "@/lib/transport";
import type { AcpAgent } from "@/types/events";

/// Every agent that speaks ACP: the public registry plus the reader's own.
/// Each starts off — the registry lists dozens nobody asked for — and one
/// turned on joins the composer's agent picker.
///
/// Dray installs none of them. A row whose command is missing links to the
/// agent's own page; Refresh looks again after the reader has installed it.
export default function AgentsSettings({ cwd }: { cwd: string }) {
  const servers = useServers();
  const [server, setServer] = useState<ServerId>(() => serverOfPath(cwd));
  const agents = useAcpAgents(server);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? agents.filter((a) => `${a.name} ${a.id} ${a.description}`.toLowerCase().includes(q))
      : agents;
    // On first, so what the picker offers is never below the fold of 40 rows.
    return [...matched].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  }, [agents, query]);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <SettingsHeaderAction>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Look again for installed agents"
              className="ml-auto"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void loadAcpAgents(true, server).finally(() => setBusy(false));
              }}
            >
              {busy ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Look again for installed agents</TooltipContent>
        </Tooltip>
      </SettingsHeaderAction>

      {servers.length > 0 && (
        <ServerPicker
          label="Agents on"
          value={server}
          options={[LOCAL, ...servers.map((s) => s.id)]}
          onPick={setServer}
        />
      )}

      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter agents"
          aria-label="Filter agents"
          className="h-8"
        />
        {!adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Add agent
          </Button>
        )}
      </div>

      {error && <p className="text-ui text-destructive">{error}</p>}

      {adding && (
        <CustomAgentForm
          onCancel={() => setAdding(false)}
          onSave={(agent) =>
            run(async () => {
              await saveCustomAcpAgent(agent, server);
              setAdding(false);
            })
          }
        />
      )}

      <div className="flex flex-col">
        {shown.map((agent) => (
          <AgentRow
            key={agent.harness}
            agent={agent}
            onToggle={(on) => void run(() => setAcpAgentEnabled(agent.harness, on, server))}
            onRemove={() => void run(() => removeCustomAcpAgent(agent.id, server))}
          />
        ))}
        {shown.length === 0 && agents.length > 0 && (
          <p className="py-2 text-ui text-muted-foreground">No agent matches.</p>
        )}
      </div>
    </div>
  );
}

function AgentRow({
  agent,
  onToggle,
  onRemove,
}: {
  agent: AcpAgent;
  onToggle: (on: boolean) => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex items-start gap-3 border-b border-border py-2.5 last:border-b-0">
      <AgentIcon harness={agent.harness} className="mt-0.5 size-4 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui font-medium">{agent.name}</span>
        {agent.description && (
          <span className="line-clamp-2 text-ui text-muted-foreground">{agent.description}</span>
        )}
        <span className="truncate font-mono text-xs text-muted-foreground">{agent.command}</span>
        {!agent.installed && (
          <span className="text-ui text-muted-foreground">
            Not installed.{" "}
            {agent.website && (
              <button
                type="button"
                className="cursor-pointer text-foreground underline-offset-4 hover:underline"
                onClick={() => void openUrl(agent.website!)}
              >
                Get {agent.name}
              </button>
            )}
          </span>
        )}
      </div>
      {confirming ? (
        <CancelOrConfirm
          verb="Remove"
          autoFocus
          onCancel={() => setConfirming(false)}
          onConfirm={onRemove}
        />
      ) : (
        <div className="flex items-center gap-1">
          {agent.custom && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${agent.name}`}
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
          <Switch
            aria-label={`Show ${agent.name} in the agent picker`}
            checked={agent.enabled}
            onCheckedChange={onToggle}
          />
        </div>
      )}
    </div>
  );
}

/// Name, command line and environment for an agent the registry does not list.
/// The id is the name slugged, which is also its harness name.
function CustomAgentForm({
  onSave,
  onCancel,
}: {
  onSave: (agent: { id: string; name: string; command: string; args: string[]; env: Record<string, string> }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [line, setLine] = useState("");
  const [envText, setEnvText] = useState("");
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  // ponytail: whitespace split, no shell quoting; an argument holding a space
  // needs a wrapper script.
  const [command, ...args] = line.trim().split(/\s+/).filter(Boolean);
  const env = Object.fromEntries(
    envText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1)]),
  );

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (id && command) onSave({ id, name: name.trim(), command, args, env });
      }}
    >
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" />
      <Input
        value={line}
        onChange={(e) => setLine(e.target.value)}
        placeholder="Command, e.g. my-agent --acp"
        aria-label="Command"
        className="font-mono"
      />
      <textarea
        value={envText}
        onChange={(e) => setEnvText(e.target.value)}
        placeholder="Environment, one KEY=value per line (optional)"
        aria-label="Environment"
        rows={2}
        className="rounded-md border border-input bg-transparent px-3 py-2 font-mono text-ui outline-none placeholder:text-muted-foreground focus-visible:border-ring"
      />
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!id || !command}>
          Add
        </Button>
      </div>
    </form>
  );
}
