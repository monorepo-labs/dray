import { MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import CommandChip from "@/components/settings/CommandChip";
import { CancelOrConfirm } from "@/components/settings/InRowConfirm";
import SettingsHeaderAction from "@/components/settings/headerAction";
import ServerSetupDialog from "@/components/settings/ServerSetupDialog";
import { SpaceNameField } from "@/components/settings/SpacesSettings";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useServers } from "@/lib/servers";
import { invoke, listen, LOCAL } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { Failure, Fix, ServerInfo, ServerStatus, Stage } from "@/types/events";

type TrustHost = Extract<Fix, { kind: "trust_host" }>;

const STAGE_LABELS: Record<Stage, string> = {
  connecting: "Connecting…",
  finding: "Finding the server…",
  starting: "Starting the server…",
};

/// The rail's colours, as the Accounts tab spends them: green for reachable,
/// yellow for still trying, grey for not.
function StatusDot({ status }: { status: ServerStatus }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "connected" && "bg-accent-add",
        status === "connecting" && "bg-accent-command",
        status === "disconnected" && "bg-muted-foreground/40",
      )}
    />
  );
}

/// What a server's row says under its name: where a connect is, why it
/// failed, or simply how it is reached.
function detailOf(server: ServerInfo): string {
  const address = server.ssh ?? server.url;
  if (!server.on) return `Off · ${address}`;
  if (server.status === "connecting" && server.stage) return STAGE_LABELS[server.stage];
  if (server.status === "disconnected" && server.error) return server.error;
  return address;
}

/// Every Dray server this app shows, This Mac first. A remote one's
/// projects and sessions join the sidebar while it is connected and stay,
/// dimmed, while it is not — its agents keep running there either way.
export default function ServersSettings() {
  const servers = useServers();
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // The host-key question for a saved row, whose loop parked on it.
  const [trusting, setTrusting] = useState<{ server: ServerInfo; fix: TrustHost } | null>(null);
  // A server with no Dray on it, being set up: from its row, or from Add.
  const [installing, setInstalling] = useState<{
    line: string;
    name: string;
    connect: () => Promise<string>;
  } | null>(null);

  return (
    <>
      <SettingsHeaderAction>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setAdding(true)}>
          <Plus className="size-3.5" />
          Add server
        </Button>
      </SettingsHeaderAction>

      <div className="flex flex-col">
        <Row name="This Mac" detail="Where this app runs" status="connected" />
        {servers.map((server) => (
          // The row stays laid out under the field, hidden, so renaming moves
          // nothing: the row is as tall as its detail and fix make it, which a
          // one-line field in its place was not.
          <div key={server.id} className="relative">
            {renaming === server.id && (
              <div className="absolute inset-0 z-10 flex flex-col justify-center">
                <SpaceNameField
                  label={`Rename ${server.name}`}
                  initial={server.named ? server.name : ""}
                  action="Save"
                  placeholder={server.ssh ?? server.url}
                  allowEmpty
                  onCancel={() => setRenaming(null)}
                  onCommit={(name) => {
                    setRenaming(null);
                    void invoke("rename_server", { id: server.id, name }, LOCAL).catch(console.error);
                  }}
                />
              </div>
            )}
            <Row
            hidden={renaming === server.id}
            name={server.name}
            detail={detailOf(server)}
            status={server.status}
            fix={server.fix}
            onTrust={(fix) => setTrusting({ server, fix })}
            on={server.on}
            onToggle={(on) => void invoke("set_server_on", { id: server.id, on }, LOCAL).catch(console.error)}
            onRetry={
              !server.on || server.status !== "disconnected"
                ? undefined
                : server.fix?.kind === "install"
                  ? () =>
                      setInstalling({
                        line: server.ssh!,
                        name: server.name,
                        connect: async () => {
                          await invoke("set_server_on", { id: server.id, on: true }, LOCAL);
                          return server.id;
                        },
                      })
                  : () => void invoke("set_server_on", { id: server.id, on: true }, LOCAL).catch(console.error)
            }
            onRename={() => {
              setConfirming(null);
              setRenaming(server.id);
            }}
            confirming={confirming === server.id}
            onRemove={() => setConfirming(server.id)}
            onCancel={() => setConfirming(null)}
            onConfirm={() => {
              setConfirming(null);
              void invoke("remove_server", { id: server.id }, LOCAL).catch(console.error);
            }}
          />
          </div>
        ))}
      </div>

      <AddServerDialog
        open={adding}
        onClose={() => setAdding(false)}
        onInstall={(line, name) => {
          setAdding(false);
          setInstalling({
            line,
            name: name || line.replace(/^ssh\s+/, ""),
            connect: async () =>
              (await invoke<ServerInfo>("add_ssh_server", { line, name: name || null }, LOCAL)).id,
          });
        }}
      />
      {installing && <ServerSetupDialog {...installing} onClose={() => setInstalling(null)} />}
      {trusting?.server.ssh && (
        <HostKeyDialog
          line={trusting.server.ssh}
          fix={trusting.fix}
          onClose={() => setTrusting(null)}
          onTrusted={() => {
            const id = trusting.server.id;
            setTrusting(null);
            void invoke("set_server_on", { id, on: true }, LOCAL).catch(console.error);
          }}
        />
      )}
    </>
  );
}

function Row({
  hidden = false,
  name,
  detail,
  status,
  fix = null,
  onTrust,
  on,
  onToggle,
  onRetry,
  onRename,
  confirming = false,
  onRemove,
  onCancel,
  onConfirm,
}: {
  /// Kept for its height while a field is drawn over it.
  hidden?: boolean;
  name: string;
  detail: string;
  status: ServerStatus;
  fix?: Fix | null;
  onTrust?: (fix: TrustHost) => void;
  /// Absent for This Mac, which is the app itself and cannot be turned off.
  on?: boolean;
  onToggle?: (on: boolean) => void;
  /// Present while a connect is not running, to start one now.
  onRetry?: () => void;
  onRename?: () => void;
  confirming?: boolean;
  onRemove?: () => void;
  onCancel?: () => void;
  onConfirm?: () => void;
}) {
  // Both items put focus somewhere new — the name field, the Remove question —
  // and the menu handing it back to ⋯ as it closes would take it straight off.
  const movedFocus = useRef(false);
  const elsewhere = (then?: () => void) => () => {
    movedFocus.current = true;
    then?.();
  };

  return (
    // Opacity, not `invisible`: visibility is inherited, and `Button`'s
    // `transition-all` animates it, so the buttons lingered a beat after the
    // rest of the row was gone. `inert` keeps them out of Tab meanwhile.
    <div className={cn("flex min-h-10 items-center gap-3 py-1.5", hidden && "opacity-0")} inert={hidden}>
      <StatusDot status={status} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-ui font-medium">{name}</span>
        <span className="text-ui text-muted-foreground">
          <span className="sr-only">{status}. </span>
          {detail}
        </span>
        {fix?.kind === "copy" && <CommandChip command={fix.command} />}
        {fix?.kind === "trust_host" && (
          <Button variant="secondary" size="sm" className="self-start" onClick={() => onTrust?.(fix)}>
            Check the host key
          </Button>
        )}
      </div>
      {onRemove &&
        (confirming ? (
          // Asked in the row, the transcription models' own reading: a modal
          // is more than forgetting an address is worth.
          <CancelOrConfirm verb="Remove" onConfirm={onConfirm!} onCancel={onCancel!} autoFocus />
        ) : (
          <div className="flex items-center gap-1.5">
            {onRetry && (
              <Button variant="ghost" size="sm" onClick={onRetry}>
                Try again
              </Button>
            )}
            {onToggle && (
              <Switch aria-label={`Connect to ${name}`} checked={on} onCheckedChange={onToggle} />
            )}
            {/* The Accounts rows' ⋯: the switch is what a row is for, and the
                two that change the row itself wait behind it. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={`${name} options`}>
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-36"
                onCloseAutoFocus={(e) => {
                  if (movedFocus.current) e.preventDefault();
                  movedFocus.current = false;
                }}
              >
                {onRename && <DropdownMenuItem onSelect={elsewhere(onRename)}>Rename</DropdownMenuItem>}
                <DropdownMenuItem variant="destructive" onSelect={elsewhere(onRemove)}>
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
    </div>
  );
}

/// A rejected `add_ssh_server` carries a `Failure`; anything else is a string.
function asFailure(err: unknown): Failure {
  if (err && typeof err === "object" && "message" in err) return err as Failure;
  return { message: String(err), fix: null };
}

/// Two ways in. The SSH line is the one a reader already has: the app logs in
/// with it, forwards the server's port, reads its token and starts it if it is
/// stopped. Address and token is for a server reached some other way.
function AddServerDialog({
  open,
  onClose,
  onInstall,
}: {
  open: boolean;
  onClose: () => void;
  /// Reached Dray's absence over a working login: set it up there.
  onInstall: (line: string, name: string) => void;
}) {
  const [viaSsh, setViaSsh] = useState(true);
  const [line, setLine] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [trusting, setTrusting] = useState<TrustHost | null>(null);
  // Pressing Add starts the setup, and from then on only the buttons leave.
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (!busy || !viaSsh) return;
    let unlisten: (() => void) | undefined;
    let live = true;
    void listen<Stage>("server_adding", ({ payload, server }) => {
      if (server === LOCAL) setStage(payload);
    }).then((off) => (live ? (unlisten = off) : off()));
    return () => {
      live = false;
      unlisten?.();
    };
  }, [busy, viaSsh]);

  const close = () => {
    setLine("");
    setUrl("");
    setToken("");
    setName("");
    setFailure(null);
    setViaSsh(true);
    setStarted(false);
    onClose();
  };

  const add = async () => {
    setStarted(true);
    setBusy(true);
    setStage(null);
    setFailure(null);
    try {
      if (viaSsh) {
        await invoke<ServerInfo>("add_ssh_server", { line, name: name.trim() || null }, LOCAL);
      } else {
        await invoke<ServerInfo>("add_server", { url, token, name: name.trim() || null }, LOCAL);
      }
      close();
    } catch (err) {
      const failed = asFailure(err);
      if (failed.fix?.kind === "install") {
        const [l, n] = [line.trim(), name.trim()];
        close();
        onInstall(l, n);
        return;
      }
      setFailure(failed);
      if (failed.fix?.kind === "trust_host") setTrusting(failed.fix);
    } finally {
      setBusy(false);
      setStage(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void add();
  };

  const ready = viaSsh ? line.trim() : url.trim() && token.trim();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="grid-cols-[minmax(0,1fr)]" showClose={false} dismissible={!started}>
        <DialogHeader>
          <DialogTitle>Add server</DialogTitle>
          <DialogDescription>
            {viaSsh
              ? "Run sessions on a machine you can SSH into. Dray uses your existing key."
              : "Connect straight to a running dray serve."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          {viaSsh ? (
            <Field label="SSH" hint="The line you log in with. -p and ~/.ssh/config names work.">
              <Input
                value={line}
                onChange={(e) => setLine(e.target.value)}
                placeholder="ssh root@203.0.113.7"
                autoFocus
                required
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </Field>
          ) : (
            <>
              <Field label="Address">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="127.0.0.1:7317" autoFocus required />
              </Field>
              <Field label="Token" hint="In serve-token, in the server's Dray directory.">
                <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} required />
              </Field>
            </>
          )}
          <Field label="Name" hint="Optional. Drawn after its projects' names in the sidebar.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="vps" />
          </Field>
          {failure && (
            <div className="flex flex-col items-start gap-1.5">
              <p className="text-ui text-destructive">{failure.message}</p>
              {failure.fix?.kind === "copy" && <CommandChip command={failure.fix.command} />}
              {failure.fix?.kind === "trust_host" && (
                <Button type="button" variant="secondary" size="sm" onClick={() => setTrusting(failure.fix as TrustHost)}>
                  Check the host key
                </Button>
              )}
            </div>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 self-start text-muted-foreground"
            disabled={busy}
            onClick={() => {
              setViaSsh(!viaSsh);
              setFailure(null);
            }}
          >
            {viaSsh ? "Use an address and token instead" : "Use an SSH login instead"}
          </Button>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !ready}>
              {busy ? (stage ? STAGE_LABELS[stage] : "Connecting…") : failure ? "Try again" : "Add"}
            </Button>
          </div>
        </form>
      </DialogContent>
      {trusting && (
        <HostKeyDialog
          line={line}
          fix={trusting}
          onClose={() => setTrusting(null)}
          onTrusted={() => {
            setTrusting(null);
            void add();
          }}
        />
      )}
    </Dialog>
  );
}

/// The question `ssh` asks the first time it meets a server, asked here since
/// the app's `ssh` never stops on a prompt. Yes files the key in known_hosts
/// the way ssh would; from then on ssh itself refuses any other key.
function HostKeyDialog({
  line,
  fix,
  onClose,
  onTrusted,
}: {
  line: string;
  fix: TrustHost;
  onClose: () => void;
  onTrusted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyFile = `/etc/ssh/ssh_host_${fix.keyType.toLowerCase()}_key.pub`;

  const trust = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("trust_host_key", { line, fingerprint: fix.fingerprint }, LOCAL);
      onTrusted();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open>
      <DialogContent className="grid-cols-[minmax(0,1fr)]" showClose={false} dismissible={false}>
        <DialogHeader>
          <DialogTitle>Is this the right server?</DialogTitle>
          <DialogDescription>
            This Mac has never connected to {fix.host}. Its {fix.keyType} key fingerprint is:
          </DialogDescription>
        </DialogHeader>
        <code className="rounded-md border border-border px-2 py-1.5 font-mono text-code break-all dark:border-input">
          {fix.fingerprint}
        </code>
        <p className="text-ui text-muted-foreground">
          To check it, run this on the server and compare:
        </p>
        <CommandChip command={`ssh-keygen -lf ${keyFile}`} />
        {error && <p className="text-ui text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={() => void trust()} autoFocus>
            {busy ? "Saving…" : "Trust and connect"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-ui font-medium">{label}</span>
      {children}
      {hint && <span className="text-ui text-muted-foreground">{hint}</span>}
    </label>
  );
}
