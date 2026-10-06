import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { CancelOrConfirm } from "@/components/settings/InRowConfirm";
import SettingsHeaderAction from "@/components/settings/headerAction";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useServers } from "@/lib/servers";
import { invoke, LOCAL } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { ServerInfo, ServerStatus } from "@/types/events";

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

/// Every Dray server this app shows, Local Server first. A remote one's
/// projects and sessions join the sidebar while it is connected and stay,
/// dimmed, while it is not — its agents keep running there either way.
export default function ServersSettings() {
  const servers = useServers();
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <>
      <SettingsHeaderAction>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setAdding(true)}>
          <Plus className="size-3.5" />
          Add server
        </Button>
      </SettingsHeaderAction>

      <div className="flex flex-col">
        <Row name="Local Server" detail="This Mac" status="connected" />
        {servers.map((server) => (
          <Row
            key={server.id}
            name={server.name}
            detail={server.status === "disconnected" && server.error ? server.error : server.url}
            status={server.status}
            confirming={confirming === server.id}
            onRemove={() => setConfirming(server.id)}
            onCancel={() => setConfirming(null)}
            onConfirm={() => {
              setConfirming(null);
              void invoke("remove_server", { id: server.id }, LOCAL).catch(console.error);
            }}
          />
        ))}
      </div>

      <AddServerDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function Row({
  name,
  detail,
  status,
  confirming = false,
  onRemove,
  onCancel,
  onConfirm,
}: {
  name: string;
  detail: string;
  status: ServerStatus;
  confirming?: boolean;
  /// Absent for Local Server, which is the app itself.
  onRemove?: () => void;
  onCancel?: () => void;
  onConfirm?: () => void;
}) {
  return (
    <div className="flex min-h-10 items-center gap-3 py-1.5">
      <StatusDot status={status} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui font-medium">{name}</span>
        <span className="truncate text-ui text-muted-foreground" title={detail}>
          <span className="sr-only">{status}. </span>
          {detail}
        </span>
      </div>
      {onRemove &&
        (confirming ? (
          // Asked in the row, the transcription models' own reading: a modal
          // is more than forgetting an address is worth.
          <CancelOrConfirm verb="Remove" onConfirm={onConfirm!} onCancel={onCancel!} autoFocus />
        ) : (
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        ))}
    </div>
  );
}

/// Address and token for a `dray serve` already running and reachable. The
/// token is admitted by the server before anything is saved, so a typo is
/// refused here rather than becoming a row that never connects.
// ponytail: one way in. Stage 4 adds connecting by SSH line, a second form
// behind a switch at the top of this dialog.
function AddServerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setUrl("");
    setToken("");
    setName("");
    setError(null);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await invoke<ServerInfo>("add_server", { url, token, name: name.trim() || null }, LOCAL);
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add server</DialogTitle>
          <DialogDescription>
            A <code>dray serve</code> this Mac can reach — on this machine, over Tailscale, or through an SSH tunnel.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <Field label="Address">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="127.0.0.1:7317" autoFocus required />
          </Field>
          <Field label="Token" hint="In serve-token, in the server's Dray directory.">
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} required />
          </Field>
          <Field label="Name" hint="Optional. Drawn after its projects' names in the sidebar.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="vps" />
          </Field>
          {error && <p className="text-ui text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !url.trim() || !token.trim()}>
              {busy ? "Connecting…" : "Add"}
            </Button>
          </div>
        </form>
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
