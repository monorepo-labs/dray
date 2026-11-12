import { drawsFailure } from "@/lib/transcript";
import type { AgentEvent, Harness } from "@/types/events";
import type { JsonValue } from "@/types/serde_json/JsonValue";

/// One row of a bot's chat. A bot is talked to like a person, so its chat draws
/// the conversation and the tasks it started, never the tool calls between.
export type BotItem =
  | { kind: "user"; event: AgentEvent }
  | { kind: "assistant"; event: AgentEvent }
  /// An error, or a turn that failed: drawn as the transcript draws them, since
  /// a bot turn that fails before answering otherwise ends with no word why.
  | { kind: "notice"; event: AgentEvent }
  | { kind: "task"; key: string; sessionId: string; ts: string }
  | { kind: "report"; event: AgentEvent; sessionId: string; title: string }
  | { kind: "sent"; key: string; target: string; text: string; ts: string }
  /// A message from another bot, by `dray bot send` or a send to its chat.
  | { kind: "botMessage"; event: AgentEvent; botId: string; title: string }
  /// A message this bot sent another, `bot` being the name or id it used.
  /// `botId` is the one the CLI printed, absent from a send made before it did.
  | { kind: "botSent"; key: string; bot: string; botId?: string; text: string; ts: string }
  /// Where the chat moved to another agent: one session ends and the next begins.
  | { kind: "switch"; key: string; harness: Harness; ts: string };

/// One session of a bot's chat. An agent switch starts a new one, and the chat
/// draws them all in order.
export type BotSegment = { sessionId: string; harness: Harness; created: string; events: readonly AgentEvent[] };

/// The rows of a bot's whole chat, its sessions oldest first, with a line where
/// the agent changed.
export function chatItems(segments: readonly BotSegment[]): BotItem[] {
  return segments.flatMap((segment, i) => {
    const items = botItems(segment.events);
    if (i === 0 || segments[i - 1].harness === segment.harness) return items;
    const ts = segment.events[0]?.ts ?? segment.created;
    return [{ kind: "switch" as const, key: `switch:${segment.sessionId}`, harness: segment.harness, ts }, ...items];
  });
}

/// When an item happened, for the chat's time labels — never its order, which
/// is the log's.
export function itemTime(item: BotItem | BotRow): string {
  if (item.kind === "talk") return itemTime(item.items[0]);
  return "event" in item ? item.event.ts : item.ts;
}

/// The pause after which a chat says the time again, as a messenger does.
const TIME_GAP_MS = 15 * 60_000;

/// Whether `row` opens with a time label: the first one does, and any after a
/// pause of `TIME_GAP_MS` or more since the one before.
export function startsTimeRun(prev: string | null, at: string): boolean {
  if (prev === null) return true;
  return Date.parse(at) - Date.parse(prev) >= TIME_GAP_MS;
}

/// A messenger's time label, vaguer with age: "Today 18:44", "Yesterday 18:44",
/// "Tuesday 18:44" within the week, "Tue, Nov 10 18:21" before it, with the
/// year once it is not this one. A 24-hour clock, as the sidebar keeps.
export function chatTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const clock = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  if (days > 1 && days < 7) return `${at.toLocaleDateString([], { weekday: "long" })} ${clock}`;
  const date = at.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date} ${clock}`;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const STARTS_SESSION = /\bdray\s+(session\s+new|new)\b/;
const TASK_ID = new RegExp(`^\\s*(${UUID.source})\\s*$`, "im");
const SENDS = /\bdray\s+(?:(session|bot)\s+)?send\b/g;
/// What `dray bot send` prints, in `apps/cli/src/bot.rs`.
const BOT_SENT = new RegExp(`^(?:Sent to|Queued for) bot ".*" \\((${UUID.source})\\)\\.$`, "gim");

/// The first shell word of `text` and its length: quoted, which a bot's name
/// with a space needs, or bare.
function firstWord(text: string): { word: string; length: number } | null {
  const quote = text[0];
  if (quote === "'" || quote === '"') {
    const end = text.indexOf(quote, 1);
    return end > 0 ? { word: text.slice(1, end), length: end + 1 } : null;
  }
  const word = text.match(/^\S+/)?.[0];
  return word ? { word, length: word.length } : null;
}

/// The message a shell word carries: a heredoc fed through `$(cat <<EOF …)`,
/// a single- or double-quoted string, or a bare word. Best effort, since it is
/// only ever drawn: a shape it misreads shows the raw text, never a wrong task.
export function shellMessage(word: string): string {
  return shellWord(word).value;
}

/// The shell word `text` starts with, and how much of `text` it took.
function shellWord(text: string): { value: string; length: number } {
  const heredoc = text.match(/^"?\$\(cat\s+<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\s*\1\s*\n?\s*\)/);
  if (heredoc) {
    const closed = text.startsWith('"') && text[heredoc[0].length] === '"';
    return { value: heredoc[2], length: heredoc[0].length + (closed ? 1 : 0) };
  }
  if (text.startsWith("'")) {
    let out = "";
    let i = 1;
    while (i < text.length) {
      if (text.startsWith("'\\''", i)) {
        out += "'";
        i += 4;
      } else if (text[i] === "'") {
        return { value: out, length: i + 1 };
      } else {
        out += text[i++];
      }
    }
    return { value: out, length: text.length };
  }
  if (text.startsWith('"')) {
    let out = "";
    for (let i = 1; i < text.length; i++) {
      if (text[i] === "\\" && i + 1 < text.length) out += text[++i];
      else if (text[i] === '"') return { value: out, length: i + 1 };
      else out += text[i];
    }
    return { value: out, length: text.length };
  }
  const bare = text.match(/^\S*/)![0];
  return { value: bare, length: bare.length };
}

/// Every `dray session send` and `dray bot send` in one command the bot ran —
/// one command often carries several, joined by `&&` — each with who to, what
/// it said, and whether it went to a bot. A send spelled out inside another's
/// message is that message's text, so the search resumes after each message.
export function sentMessages(cmd: string): { target: string; text: string; bot?: true }[] {
  const out: { target: string; text: string; bot?: true }[] = [];
  let cursor = 0;
  for (const m of cmd.matchAll(SENDS)) {
    if (m.index < cursor) continue;
    let at = m.index + m[0].length;
    const skipSpace = () => {
      while (at < cmd.length && /\s/.test(cmd[at])) at++;
    };
    skipSpace();
    const target = firstWord(cmd.slice(at));
    if (!target) continue;
    at += target.length;
    skipSpace();
    const message = shellWord(cmd.slice(at));
    if (message.length === 0) continue;
    cursor = at + message.length;
    const sent = { target: target.word, text: message.value };
    out.push(m[1] === "bot" ? { ...sent, bot: true as const } : sent);
  }
  return out;
}

function command(input: JsonValue): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = (input as Record<string, JsonValue>).command;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join(" ");
  return null;
}

/// Where unread replies begin: the first of the bot's replies after the
/// reader's own last message, the point they had read up to.
export function firstUnread(items: readonly BotItem[]): string | null {
  let mark: string | null = null;
  for (const item of items) {
    if (item.kind === "user") {
      mark = null;
    } else if (item.kind === "assistant" && mark === null) {
      mark = item.event.id;
    }
  }
  return mark;
}

/// Messages between the bot and its tasks, one way or the other.
export type TalkItem = Extract<BotItem, { kind: "report" | "sent" }>;
/// What a bot's chat draws: its items, with each run of messages between the
/// bot and its tasks that nothing else interrupts folded into one line.
export type BotRow = Exclude<BotItem, TalkItem> | { kind: "talk"; key: string; items: TalkItem[] };

/// Folds each uninterrupted run of messages between the bot and its tasks into
/// one row, the way a chat collapses a burst of messages to several people.
export function botRows(items: readonly BotItem[]): BotRow[] {
  const rows: BotRow[] = [];
  for (const item of items) {
    if (item.kind !== "report" && item.kind !== "sent") {
      rows.push(item);
      continue;
    }
    const last = rows[rows.length - 1];
    if (last?.kind === "talk") last.items.push(item);
    else rows.push({ kind: "talk", key: item.kind === "report" ? item.event.id : item.key, items: [item] });
  }
  return rows;
}

/// The rows of a bot's chat, in log order.
///
/// A task is found by its `dray session new` call and named by the id that
/// command prints alone on its first stdout line — printed that way so a shell
/// can capture it, which is what makes reading it back here safe.
export function botItems(events: readonly AgentEvent[]): BotItem[] {
  const starts = new Set<string>();
  const sends = new Map<string, ReturnType<typeof sentMessages>>();
  const items: BotItem[] = [];
  for (const event of events) {
    if (event.subagent) continue;
    const p = event.payload;
    if (p.type === "user_message") {
      // A task's report-back is the bot's input, not the reader's: the bot's
      // reply carries what it said, so the chat names who wrote and folds the rest.
      if (p.from?.botId) items.push({ kind: "botMessage", event, botId: p.from.botId, title: p.from.title });
      else if (p.from) items.push({ kind: "report", event, sessionId: p.from.sessionId, title: p.from.title });
      else if (!p.kickoff) items.push({ kind: "user", event });
    } else if (p.type === "assistant_text") {
      if (p.text.trim()) items.push({ kind: "assistant", event });
    } else if (p.type === "error") {
      items.push({ kind: "notice", event });
    } else if (p.type === "turn_completed" && drawsFailure(p)) {
      // The harness says the failure twice, as text and on the turn; the red
      // row wins, as in the transcript.
      const last = items[items.length - 1];
      const sentence = p.finalText?.trim();
      if (
        sentence &&
        last?.kind === "assistant" &&
        last.event.payload.type === "assistant_text" &&
        last.event.payload.text.trim() === sentence
      ) {
        items.pop();
      }
      items.push({ kind: "notice", event });
    } else if (p.type === "tool_call_started") {
      const cmd = command(p.input);
      if (cmd && STARTS_SESSION.test(cmd)) starts.add(p.callId);
      const sent = cmd ? sentMessages(cmd) : [];
      if (sent.length > 0) sends.set(p.callId, sent);
    } else if (p.type === "tool_call_completed" && !p.result.isError) {
      // One command can both start a task and send, so each is read on its own.
      if (starts.has(p.callId)) {
        // `dray session new` prints the id alone on its line, unlike a send's.
        const id = p.result.text.match(TASK_ID)?.[1];
        if (id) items.push({ kind: "task", key: p.callId, sessionId: id, ts: event.ts });
      }
      // `dray bot send` names the bot it reached on a line of its own, one per
      // send in order; its id still names the bot after a rename. Matched on
      // that line alone, since anything else in the command may print ids.
      const ids = [...p.result.text.matchAll(BOT_SENT)].map((m) => m[1]);
      sends.get(p.callId)?.forEach(({ bot, target, text }, i) => {
        const key = `${p.callId}:${i}`;
        items.push(
          bot
            ? { kind: "botSent", key, bot: target, botId: ids.shift(), text, ts: event.ts }
            : { kind: "sent", key, target, text, ts: event.ts },
        );
      });
    }
  }
  return items;
}
