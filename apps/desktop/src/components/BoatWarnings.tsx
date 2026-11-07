import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AUTO_EXTEND_MINUTES,
  countdown,
  EXTEND_HOURS,
  extendBoat,
  setBoatPrefs,
  useBoatPrefs,
} from "@/lib/boat";
import { channel } from "@/lib/channel";
import { useServers } from "@/lib/servers";
import type { ServerInfo } from "@/types/events";

/// Ticks once a second, for a countdown a reader watches.
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return now;
}

/// Extend by the last value picked, with the others behind the arrow: the merge
/// button's shape. Picking from the menu changes the button, never extends, so
/// the arrow is never a second way to spend hours by accident. Boat's refusal —
/// a trial's 2-hour cap, say — goes to `onFail`.
export function ExtendBoat({
  id,
  onFail,
  onDone,
  size = "xs",
}: {
  id: string;
  onFail: (why: string) => void;
  onDone?: () => void;
  size?: "xs" | "sm";
}) {
  const { hours } = useBoatPrefs();
  const [busy, setBusy] = useState(false);
  const extend = () => {
    setBusy(true);
    extendBoat(id, hours * 60)
      .then(onDone)
      .catch((e) => onFail(String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex shrink-0 items-center rounded-[min(var(--radius-md),12px)] shadow-(--shadow-button)">
      <Button size={size} className="rounded-r-none" disabled={busy} onClick={extend}>
        {busy ? "Extending…" : `Extend ${hours} hrs`}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size={size} className="rounded-l-none border-l border-background/20 px-1.5" disabled={busy} aria-label="Extend by">
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-36">
          <DropdownMenuLabel className="text-ui-sm font-normal text-muted-foreground">Keep running for</DropdownMenuLabel>
          {EXTEND_HOURS.map((value) => (
            <DropdownMenuItem key={value} onSelect={() => setBoatPrefs({ hours: value })}>
              {value} hours
              {value === hours && <Check className="ml-auto size-3.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const CARD = "pointer-events-auto flex flex-col gap-2 py-2.5 pr-2.5 pl-3 shadow-lg ring-1 ring-foreground/10 animate-in fade-in slide-in-from-bottom-2";

function Warning({ server, stopsAt, now, onDismiss }: { server: ServerInfo; stopsAt: string; now: number; onDismiss: () => void }) {
  const [failed, setFailed] = useState<string | null>(null);
  const { offered } = useBoatPrefs();
  return (
    <Alert className={CARD}>
      <AlertTitle className="flex min-w-0 items-baseline gap-1 text-ui">
        <span className="truncate" title={server.name}>{server.name}</span>
        <span className="shrink-0 font-normal text-muted-foreground">stops in</span>
        <span className="shrink-0 tabular-nums">{countdown(stopsAt, now)}</span>
      </AlertTitle>
      {failed && <p className="text-ui-sm text-destructive">{failed}</p>}
      <span className="flex items-center gap-1">
        <ExtendBoat id={server.id} onFail={setFailed} onDone={() => !offered && setOffer(true)} />
        <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onDismiss}>
          Dismiss
        </Button>
      </span>
    </Alert>
  );
}

/// Shown once, after the reader's first Extend: the moment they have just
/// learned what running out costs.
let showOffer = false;
const offerChanged = channel<void>();
function setOffer(on: boolean) {
  showOffer = on;
  offerChanged.emit();
}

function AutoOffer() {
  return (
    <Alert className={CARD}>
      <p className="text-ui">
        Add {AUTO_EXTEND_MINUTES} minutes on its own when a sandbox is about to stop mid-task?
      </p>
      <span className="flex items-center gap-1">
        <Button
          size="xs"
          onClick={() => {
            setBoatPrefs({ auto: true, offered: true });
            setOffer(false);
          }}
        >
          Turn on
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={() => {
            setBoatPrefs({ offered: true });
            setOffer(false);
          }}
        >
          Not now
        </Button>
      </span>
    </Alert>
  );
}

/// Gives a sandbox about to stop more time while work runs on it, if the reader
/// turned that on. At the warning rather than the last second: boat's timer is
/// read once a minute, and the reader then never sees a card for it.
function useAutoExtend(busy: (server: string) => boolean) {
  const servers = useServers();
  const { auto } = useBoatPrefs();
  const done = useRef(new Set<string>());
  useEffect(() => {
    if (!auto) return;
    for (const server of servers) {
      const stopsAt = server.boat?.warning ? server.boat.stopsAt : null;
      const key = `${server.id}:${stopsAt}`;
      if (!stopsAt || done.current.has(key) || !busy(server.id)) continue;
      done.current.add(key);
      void extendBoat(server.id, AUTO_EXTEND_MINUTES).catch(console.error);
    }
  }, [servers, auto, busy]);
}

/// A sandbox about to auto-stop, floating at the sidebar's foot and past the
/// window's own focus. Outside the sidebar, so collapsing it hides nothing, and
/// no countdown bar unlike a notice card: it stands until the time is extended
/// or it stops, since missing it costs running work.
export default function BoatWarnings({ busy }: { busy: (server: string) => boolean }) {
  const servers = useServers();
  const now = useNow();
  const { auto } = useBoatPrefs();
  useAutoExtend(busy);
  const offer = useSyncExternalStore(offerChanged.subscribe, () => showOffer);
  // By deadline, so an extend that runs out later warns again.
  const [dismissed, setDismissed] = useState<string[]>([]);
  const up = servers.flatMap((server) => {
    const stopsAt = server.boat?.warning ? server.boat.stopsAt : null;
    const handled = auto && busy(server.id);
    return stopsAt && !handled && !dismissed.includes(`${server.id}:${stopsAt}`) ? [{ server, stopsAt }] : [];
  });
  if (!up.length && !offer) return null;
  return (
    <div className="pointer-events-none fixed bottom-12 left-3 z-50 flex w-64 flex-col gap-2">
      {offer && <AutoOffer />}
      {up.map(({ server, stopsAt }) => (
        <Warning
          key={server.id}
          server={server}
          stopsAt={stopsAt}
          now={now}
          onDismiss={() => setDismissed((d) => [...d, `${server.id}:${stopsAt}`])}
        />
      ))}
    </div>
  );
}
