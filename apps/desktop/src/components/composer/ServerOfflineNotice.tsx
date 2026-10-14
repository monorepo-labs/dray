import { SignalSlashIcon } from "@heroicons/react/16/solid";

import Orb from "@/components/Orb";
import { Button } from "@/components/ui/button";
import { invoke, LOCAL } from "@/lib/transport";
import type { ServerInfo } from "@/types/events";

/// The open session's server is not connected. Rust reconnects on its own with
/// backoff, so this says that much and offers Try again, which skips the wait.
export default function ServerOfflineNotice({ server }: { server: ServerInfo }) {
  const connecting = server.on && server.status === "connecting";
  const reason = !server.on ? "turned off" : connecting ? "Reconnecting…" : server.error;

  return (
    <div className="mb-2 flex items-center gap-3 px-1">
      <SignalSlashIcon className="-mr-1 size-3.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 truncate text-ui text-foreground">
        {server.name} is offline
        {reason && <span className="text-muted-foreground"> · {reason}</span>}
      </p>
      {connecting ? (
        // Button height, so the row holds still as the two states trade places.
        <span className="flex h-7 shrink-0 items-center">
          <Orb state="searching" variant="lighthouse" speed={3} label="Reconnecting" />
        </span>
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
