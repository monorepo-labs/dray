import { Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  AUTO_EXTEND_MINUTES,
  countdown,
  durationLabel,
  WARN_MINUTES,
  EXTEND_STEP,
  extendBoat,
  MAX_EXTEND_MINUTES,
  setBoatPrefs,
  useBoatPrefs,
} from "@/lib/boat";
import { channel } from "@/lib/channel";
import { useServers } from "@/lib/servers";
import { cn } from "@/lib/utils";
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

/// Extend by a length stepped in 30-minute steps, then pressed: one control,
/// the island's own. Starts at the last length used. Boat's refusal — a
/// trial's 2-hour cap, say — goes to `onFail`.
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
  const { minutes: last } = useBoatPrefs();
  const [minutes, setMinutes] = useState(last);
  const [busy, setBusy] = useState(false);
  const step = (by: number) => setMinutes((m) => Math.min(MAX_EXTEND_MINUTES, Math.max(EXTEND_STEP, m + by)));
  const extend = () => {
    setBusy(true);
    setBoatPrefs({ minutes });
    extendBoat(id, minutes)
      .then(onDone)
      .catch((e) => onFail(String(e)))
      .finally(() => setBusy(false));
  };
  const icon = size === "xs" ? "icon-xs" : "icon-sm";
  return (
    <span className="flex items-center gap-0.5">
      <Button variant="ghost" size={icon} aria-label="Less time" disabled={busy || minutes <= EXTEND_STEP} onClick={() => step(-EXTEND_STEP)}>
        <Minus />
      </Button>
      <span className="min-w-9 text-center text-ui-sm font-medium tabular-nums">{durationLabel(minutes)}</span>
      <Button variant="ghost" size={icon} aria-label="More time" disabled={busy || minutes >= MAX_EXTEND_MINUTES} onClick={() => step(EXTEND_STEP)}>
        <Plus />
      </Button>
      <Button size={size} className="ml-auto px-2" disabled={busy} onClick={extend}>
        {busy ? "Extending…" : "Extend"}
      </Button>
    </span>
  );
}

const CARD = "pointer-events-auto flex flex-col gap-2 py-2.5 pr-2.5 pl-3 shadow-lg ring-1 ring-foreground/10 animate-in fade-in slide-in-from-bottom-2";

/// One sandbox's warning card. Exported for the demo page.
export function Warning({
  server,
  stopsAt,
  now,
  autoFailed,
  onDismiss,
}: {
  server: ServerInfo;
  stopsAt: string;
  now: number;
  autoFailed?: string;
  onDismiss: () => void;
}) {
  const [failed, setFailed] = useState<string | null>(autoFailed ?? null);
  const { offered } = useBoatPrefs();
  const left = new Date(stopsAt).getTime() - now;
  // The last two minutes turn red, the notice cards' colour for a loss.
  const urgent = left <= 2 * 60_000;
  // Drains over the warning, the way a notice card's bar drains its own clock.
  const fraction = Math.min(1, Math.max(0, left / (WARN_MINUTES * 60_000)));
  return (
    <Alert className={cn(CARD, "relative overflow-hidden")}>
      <span className="flex min-w-0 items-start gap-2">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 gap-1 text-ui-sm text-muted-foreground">
            <span className="truncate" title={server.name}>
              {server.name}
            </span>
            <span className="shrink-0">stops in</span>
          </span>
          <span className={cn("text-lg leading-tight font-semibold tabular-nums", urgent && "text-destructive")}>
            {countdown(stopsAt, now)}
          </span>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Dismiss ${server.name}'s warning`}
          className="-mt-0.5 -mr-0.5 text-muted-foreground"
          onClick={onDismiss}
        >
          <X />
        </Button>
      </span>
      {failed && <p className="text-ui-sm text-destructive">{failed}</p>}
      <ExtendBoat id={server.id} onFail={setFailed} onDone={() => !offered && setOffer(true)} />
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-0 bottom-0 h-0.5 origin-left transition-transform duration-1000 ease-linear",
          urgent ? "bg-destructive/70" : "bg-accent-command/70",
        )}
        style={{ transform: `scaleX(${fraction})` }}
      />
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
        <Button
          size="xs"
          onClick={() => {
            setBoatPrefs({ auto: true, offered: true });
            setOffer(false);
          }}
        >
          Turn on
        </Button>
      </span>
    </Alert>
  );
}

/// Gives a sandbox about to stop more time while work runs on it, if the reader
/// turned that on. At the warning rather than the last second: boat's timer is
/// read once a minute, and the reader then never sees a card for it.
function useAutoExtend(busy: (server: string) => boolean, onFail: (key: string, why: string) => void) {
  const servers = useServers();
  const { auto } = useBoatPrefs();
  // Tried once per deadline: a refusal is the reader's to see, not to retry.
  const done = useRef(new Set<string>());
  useEffect(() => {
    if (!auto) return;
    for (const server of servers) {
      const stopsAt = server.boat?.warning ? server.boat.stopsAt : null;
      const key = `${server.id}:${stopsAt}`;
      if (!stopsAt || done.current.has(key) || !busy(server.id)) continue;
      done.current.add(key);
      extendBoat(server.id, AUTO_EXTEND_MINUTES).catch((e) => onFail(key, String(e)));
    }
  }, [servers, auto, busy, onFail]);
}

/// Owns the clock, so nothing ticks while no card is up.
function LiveWarning(props: Omit<Parameters<typeof Warning>[0], "now">) {
  return <Warning {...props} now={useNow()} />;
}

/// A sandbox about to auto-stop, floating at the sidebar's foot. Drawn outside
/// `<aside>` so collapsing it hides nothing, but sized to the default sidebar
/// (`SIDEBAR_MIN`, 240) less its rows' inset, so it reads as part of it. Its
/// bar drains like a notice card's but takes nothing down: the card stands
/// until the reader extends or dismisses it or the sandbox stops, since missing
/// it costs running work.
export default function BoatWarnings({ busy }: { busy: (server: string) => boolean }) {
  const servers = useServers();
  const { auto } = useBoatPrefs();
  // By deadline: the card comes back, with boat's reason, so the reader can.
  const [autoFailed, setAutoFailed] = useState<Record<string, string>>({});
  const onAutoFail = useCallback((key: string, why: string) => setAutoFailed((f) => ({ ...f, [key]: why })), []);
  useAutoExtend(busy, onAutoFail);
  const offer = useSyncExternalStore(offerChanged.subscribe, () => showOffer);
  // By deadline, so an extend that runs out later warns again.
  const [dismissed, setDismissed] = useState<string[]>([]);
  const up = servers.flatMap((server) => {
    const stopsAt = server.boat?.warning ? server.boat.stopsAt : null;
    const handled = auto && busy(server.id) && !autoFailed[`${server.id}:${stopsAt}`];
    return stopsAt && !handled && !dismissed.includes(`${server.id}:${stopsAt}`) ? [{ server, stopsAt }] : [];
  });
  if (!up.length && !offer) return null;
  return (
    <div className="pointer-events-none fixed bottom-2 left-2 z-50 flex w-56 flex-col gap-2">
      {offer && <AutoOffer />}
      {up.map(({ server, stopsAt }) => (
        <LiveWarning
          key={server.id}
          server={server}
          stopsAt={stopsAt}
          autoFailed={autoFailed[`${server.id}:${stopsAt}`]}
          onDismiss={() => setDismissed((d) => [...d, `${server.id}:${stopsAt}`])}
        />
      ))}
    </div>
  );
}
