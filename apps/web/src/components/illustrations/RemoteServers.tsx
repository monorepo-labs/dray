import type { ReactNode } from "react";
import { Laptop, Moon, Server } from "lucide-react";

import Orb from "@/components/app/Orb";
import { SessionRow } from "@/components/app/Sidebar";
import { cx } from "@/components/app/Window";
import { ScaledWindow } from "./ScaledWindow";
import s from "./RemoteServers.module.css";

const WIDTH = 1128;
const HEIGHT = 306;

/// Card geometry, in the drawing's own px: the wires are drawn to these.
const CARD_W = 460;
const INSET = 64;
const WIRE_H = 64;
const LEFT_X = INSET + CARD_W / 2;
const RIGHT_X = WIDTH - INSET - CARD_W / 2;

/// The machines a Dray app drives, as a diagram rather than a window: the
/// laptop at the top, wired to a Linux box and a Mac mini, each listing the
/// sessions running on it. The laptop goes to sleep — its own session stops
/// with it and the wires go quiet — but the servers' sessions carry on and
/// finish; it wakes to them waiting, marked unread, the way the sidebar
/// marks any finished turn.
export function RemoteServers({ className }: { className?: string }) {
  return (
    <ScaledWindow width={WIDTH} height={HEIGHT} minScale={0.6} className={`${s.scene} ${className ?? ""}`}>
      <div aria-hidden data-app-window className="flex h-full w-full flex-col select-none">
        <Machine
          className={`mx-auto ${s.laptop}`}
          icon={
            <span className="grid">
              <Laptop className={`col-start-1 row-start-1 size-4 ${s.awake}`} />
              <Moon className={`col-start-1 row-start-1 size-4 ${s.asleep}`} />
            </span>
          }
          name="MacBook Pro"
          detail={
            <span className="grid">
              <span className={`col-start-1 row-start-1 ${s.awake}`}>The Dray app</span>
              <span className={`col-start-1 row-start-1 ${s.asleep}`}>Asleep</span>
            </span>
          }
          dot={s.dot}
        >
          <SessionRow title="Homepage drawings" trailing={<span className={s.awake}><Orb /></span>} />
          <SessionRow title="Fix the sidebar flicker" trailing="5m" />
        </Machine>

        <Wires />

        <div className="flex justify-between" style={{ paddingInline: INSET }}>
          <Machine icon={<Server className="size-4" />} name="hetzner" detail="Ubuntu 24.04">
            <SessionRow
              title="Load test staging"
              unread="add"
              unreadClassName={s.mark}
              trailing={<Settling spin={s.spin1} done={s.done1} />}
            />
            <SessionRow title="Nightly backup script" trailing={<Orb />} />
            <SessionRow title="Rotate the API keys" trailing="1h" />
          </Machine>
          <Machine icon={<MacMiniIcon />} name="mac-mini" detail="macOS 26">
            <SessionRow
              title="iOS release build"
              unread="add"
              unreadClassName={s.mark}
              trailing={<Settling spin={s.spin2} done={s.done2} />}
            />
            <SessionRow title="Screenshot every page" trailing={<Orb />} />
            <SessionRow title="Fix flaky UI tests" trailing="3h" />
          </Machine>
        </div>
      </div>
    </ScaledWindow>
  );
}

/// One machine: what it is, whether it is up, and what runs on it. Drawn as
/// the app's own sheet, so it reads as part of the same product.
function Machine({
  icon,
  name,
  detail,
  dot,
  children,
  className,
}: {
  icon: ReactNode;
  name: string;
  detail: ReactNode;
  /// The status dot's animation class, where it ever goes out.
  dot?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx("app-sheet shrink-0 overflow-hidden rounded-xl border border-border shadow-window", className)}
      style={{ width: CARD_W }}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 text-ui">
        <span className="text-muted-foreground">{icon}</span>
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground">{detail}</span>
        <span className={cx("ml-auto size-1.5 rounded-full bg-accent-add", dot)} />
      </div>
      <div className="flex flex-col gap-px px-2 pb-2">{children}</div>
    </div>
  );
}

/// The orb while the session works, then the time it finished — one cell, so
/// the swap moves nothing.
function Settling({ spin, done }: { spin: string; done: string }) {
  return (
    <span className="grid justify-items-end">
      <span className={`col-start-1 row-start-1 flex items-center ${s.spin} ${spin}`}>
        <Orb />
      </span>
      <span className={`col-start-1 row-start-1 ${s.done} ${done}`}>now</span>
    </span>
  );
}

/// The wires from the laptop down to each server, with a dash that flows down
/// them while the app is connected.
function Wires() {
  const mid = WIRE_H / 2;
  return (
    <svg className="shrink-0" width={WIDTH} height={WIRE_H} viewBox={`0 0 ${WIDTH} ${WIRE_H}`} fill="none">
      {[LEFT_X, RIGHT_X].map((x) => {
        const d = `M${WIDTH / 2} 0 V${mid} H${x} V${WIRE_H}`;
        return (
          <g key={x}>
            <path d={d} className="stroke-border" />
            <path d={d} className={`stroke-muted-foreground ${s.flow}`} strokeDasharray="3 9" />
          </g>
        );
      })}
    </svg>
  );
}

/// A Mac mini from the front: a flat rounded box with its light.
function MacMiniIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="size-4" aria-hidden>
      <rect x="3" y="8" width="18" height="8" rx="2.5" />
      <circle cx="17" cy="12" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}
