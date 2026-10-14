import { Button } from "@/components/ui/button";
import Spinner from "@/components/ui/spinner";
import { invoke, LOCAL } from "@/lib/transport";
import type { ServerInfo } from "@/types/events";

/// The open session's server is not connected. Rust reconnects on its own with
/// backoff, so this says that much and offers Try again, which skips the wait.
/// Drawn in `AgentMissingNotice`'s frame, for its reason: a state the composer
/// is in, not a failure that landed.
export default function ServerOfflineNotice({ server }: { server: ServerInfo }) {
  const connecting = server.on && server.status === "connecting";
  const reason = !server.on ? "turned off" : connecting ? "Reconnecting…" : server.error;

  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2">
      <p className="min-w-0 flex-1 truncate text-ui text-foreground">
        {server.name} is offline
        {reason && <span className="text-muted-foreground"> · {reason}</span>}
      </p>
      {connecting ? (
        <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => void invoke("set_server_on", { id: server.id, on: true }, LOCAL).catch(console.error)}
        >
          {server.on ? "Try again" : "Turn on"}
        </Button>
      )}
    </div>
  );
}
