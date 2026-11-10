import { MoonIcon } from "@heroicons/react/16/solid";

import Orb from "@/components/Orb";
import { Button } from "@/components/ui/button";
import { resumeBoat } from "@/lib/boat";
import type { ServerInfo } from "@/types/events";

/// The open chat's sandbox is stopped or waking. Sits where `ServerOfflineNotice`
/// does but never blocks the composer: a send here resumes it and waits.
export default function BoatNotice({ server }: { server: ServerInfo }) {
  const waking = server.sandbox?.phase === "resuming";

  return (
    <div className="mb-2 flex min-h-7 items-center gap-2 px-1">
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        {waking ? (
          <Orb state="searching" variant="lighthouse" speed={3} label="Resuming" />
        ) : (
          <MoonIcon className="size-3.5" />
        )}
      </span>
      <p className="min-w-0 flex-1 truncate text-ui text-foreground">
        {waking ? `Resuming ${server.name}` : `${server.name} is stopped`}
        <span className="text-muted-foreground">
          {" · "}
          {waking ? "This can take a few minutes. Messages go when it's back." : (server.sandbox?.note ?? "Sending resumes it automatically.")}
        </span>
      </p>
      {!waking && (
        <Button variant="secondary" size="sm" className="shrink-0" onClick={() => void resumeBoat(server.id).catch(console.error)}>
          Resume
        </Button>
      )}
    </div>
  );
}
