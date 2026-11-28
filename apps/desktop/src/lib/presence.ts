import { isWindowFocused, onFocusChange } from "@/lib/focus";
import { invoke, onSessionNoted, serverOfSession, type ServerId } from "@/lib/transport";

/// Tells each server which of its chats the reader is looking at, so its phone
/// alerts for them hold back (#1654): the chat on screen is the alert. A server
/// cannot know this itself — a VPS has nobody at it, and the reader's desktop
/// is on another machine.
///
/// Looking = the window focused and touched in the last two minutes, the
/// Mac server's own rule for "someone is at the computer". A window left
/// focused by a reader who walked away stops counting, and the phone hears.

const IDLE_MS = 2 * 60_000;
/// Well inside the server's 60s lease, so a held chat never lapses mid-read.
export const RENEW_MS = 20_000;

/// What was last said to a server: its sessions, and when.
export type Said = { key: string; at: number };

/// The sessions to say to each server now, given what is on screen and what
/// each was last told. A server is told again when its list changed or its
/// lease is due, and told nothing at all while nothing changed and nothing is held.
export function due(
  shown: readonly string[],
  looking: boolean,
  serverOf: (session: string) => ServerId,
  said: ReadonlyMap<ServerId, Said>,
  now: number,
): Map<ServerId, string[]> {
  const want = new Map<ServerId, string[]>();
  if (looking) for (const id of shown) want.set(serverOf(id), [...(want.get(serverOf(id)) ?? []), id]);
  const out = new Map<ServerId, string[]>();
  for (const server of new Set([...said.keys(), ...want.keys()])) {
    const sessions = want.get(server) ?? [];
    const last = said.get(server);
    if (!last ? sessions.length === 0 : last.key === sessions.join("\n") && now - last.at < RENEW_MS) continue;
    out.set(server, sessions);
  }
  return out;
}

/// Whether a reader on another client of this chat's server — a phone, say —
/// has it on screen now, by that server's word. The desktop then holds its own
/// banner, island pill and sound, as that server holds the phone's push for a
/// chat on this screen. The server answers off this connection, so what this
/// app said itself is never counted, and a lapsed lease never holds.
///
/// Anything but a quick yes is no: an older server answers `unknown command`,
/// and an alert lost to a slow link is worse than one the phone also shows.
export function viewedElsewhere(sessionId: string): Promise<boolean> {
  const asked = invoke<boolean>("viewed_elsewhere", { sessionId }, serverOfSession(sessionId)).then(
    (held) => held === true,
    () => false,
  );
  const late = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ASK_MS));
  return Promise.race([asked, late]);
}

const ASK_MS = 1_500;

let shown: string[] = [];
let lastInput = Date.now();
const said = new Map<ServerId, Said>();

const looking = () => isWindowFocused() && Date.now() - lastInput < IDLE_MS;

function report() {
  const now = Date.now();
  for (const [server, sessions] of due(shown, looking(), serverOfSession, said, now)) {
    if (sessions.length) said.set(server, { key: sessions.join("\n"), at: now });
    else said.delete(server);
    // A server from before this answers `unknown command`, and holds nothing.
    void invoke("set_viewing", { sessions }, server).catch(() => {});
  }
}

/// The chats on screen now: the selected one and every pane beside it.
export function setShownChats(ids: readonly (string | null | undefined)[]) {
  const next = [...new Set(ids.filter((id): id is string => !!id))];
  if (next.join("\n") === shown.join("\n")) return;
  shown = next;
  report();
}

if (typeof window !== "undefined") {
  const touched = () => {
    const idle = Date.now() - lastInput >= IDLE_MS;
    lastInput = Date.now();
    if (idle) report();
  };
  for (const type of ["keydown", "pointerdown", "pointermove", "wheel"]) {
    window.addEventListener(type, touched, { capture: true, passive: true });
  }
  onFocusChange(report);
  // A new chat is on screen before its first send says which server it is on.
  onSessionNoted(report);
  // Renews the leases, and says "nothing" once the reader goes idle.
  setInterval(report, 10_000);
}
