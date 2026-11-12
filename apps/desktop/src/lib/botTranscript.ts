import { stripSenderPrefix } from "@/lib/relay";
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
  /// A task's pull request, posted by `dray session merge-card`.
  | { kind: "card"; event: AgentEvent }
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
/// A session id, or a prefix of one long enough to name it, as `taskOf` takes.
const SESSION_ID = /^[0-9a-f][0-9a-f-]{7,}$/i;
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

/// A heredoc from its `<<` through its closing word, as `$(cat <<EOF …)` puts
/// one inside a quoted word. Sticky, so it is tried only where the scan stands.
const HEREDOC = /<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=[ \t]*(?:\n|\)|$))/y;
/// A `$(cat ` that may open a heredoc inside double quotes, sticky as above.
const SUBSHELL = /\$\(\s*\w+\s+/y;
/// A heredoc's `<<WORD` alone: its body starts at the next newline, and the
/// rest of its own line is still commands. Never a `<<<` herestring.
const OPENER = /(?<!<)<<(?!<)-?[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|([^\s'"<>;&|()]+))/y;

/// The length of the match of sticky `re` at `at`, or 0.
function stuck(re: RegExp, cmd: string, at: number): number {
  re.lastIndex = at;
  return re.exec(cmd)?.[0].length ?? 0;
}

/// `cmd` with every quoted string, escape and heredoc blanked to spaces, so a
/// `dray … send` spelled inside a message is never read as a command — a brief
/// that named `dray session send` drew a send to nobody. One pass left to right,
/// so a `<<` inside quotes opens nothing. Same length, so an index into it is
/// an index into `cmd`.
function unquoted(cmd: string): string {
  let out = "";
  let i = 0;
  const blank = (end: number) => {
    out += cmd.slice(i, end).replace(/[^\n]/g, " ");
    i = end;
  };
  /// Heredocs opened on the current line, whose bodies follow it in order.
  const bodies: string[] = [];
  while (i < cmd.length) {
    const c = cmd[i];
    OPENER.lastIndex = i;
    const open = c === "<" ? OPENER.exec(cmd) : null;
    if (open) {
      bodies.push(open[1] ?? open[2] ?? open[3]);
      blank(i + open[0].length);
    } else if (c === "\n" && bodies.length > 0) {
      out += cmd[i++];
      for (const word of bodies.splice(0)) {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const close = new RegExp(`^[ \\t]*${escaped}[ \\t]*$\\n?`, "m").exec(cmd.slice(i));
        // Unclosed, bash reads the body to the end of input and runs none of it.
        blank(close ? i + close.index + close[0].length : cmd.length);
      }
    } else if (c === "\\") blank(Math.min(i + 2, cmd.length));
    else if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      blank(end < 0 ? cmd.length : end + 1);
    } else if (c === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') {
        const sub = cmd[j] === "$" ? stuck(SUBSHELL, cmd, j) : 0;
        const inner = sub ? stuck(HEREDOC, cmd, j + sub) : 0;
        j += cmd[j] === "\\" ? 2 : inner ? sub + inner : 1;
      }
      blank(Math.min(j + 1, cmd.length));
    } else out += cmd[i++];
  }
  return out;
}

/// Every `dray session send` and `dray bot send` in one command the bot ran —
/// one command often carries several, joined by `&&` — each with who to, what
/// it said, and whether it went to a bot. A task is named by its id or an id
/// prefix, so a session send to anything else — a loop's `"$id"`, a word
/// misread — is skipped rather than drawn as a task that opens nothing.
export function sentMessages(cmd: string): { target: string; text: string; bot?: true }[] {
  const out: { target: string; text: string; bot?: true }[] = [];
  for (const m of unquoted(cmd).matchAll(SENDS)) {
    let at = m.index + m[0].length;
    const skipSpace = () => {
      while (at < cmd.length && /\s/.test(cmd[at])) at++;
    };
    skipSpace();
    const target = firstWord(cmd.slice(at));
    if (!target || (m[1] !== "bot" && !SESSION_ID.test(target.word))) continue;
    at += target.length;
    skipSpace();
    const message = shellWord(cmd.slice(at));
    if (message.length === 0) continue;
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
    } else if (p.type === "merge_card") {
      items.push({ kind: "card", event });
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
      if (cmd && STARTS_SESSION.test(unquoted(cmd))) starts.add(p.callId);
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

/// What a stalled task's row in the "Waiting on you" card scrolls the chat to,
/// by item key: the bot's reply to the task's last report, everything it did
/// before the next message came in. The report itself stays folded, since the
/// reply already says what it held. A stall nudge is Dray's, not the task's, so
/// it is skipped. With no reply to point at, the line that started the task.
export function taskContext(items: readonly BotItem[], sessionId: string): Set<string> {
  let at = items.length - 1;
  for (; at >= 0; at--) {
    const i = items[at];
    if (
      i.kind === "report" &&
      i.sessionId === sessionId &&
      i.event.payload.type === "user_message" &&
      !stripSenderPrefix(i.event.payload.text, i.event.payload.from).startsWith(NUDGE)
    ) {
      break;
    }
  }
  const keys = new Set<string>();
  for (const item of at < 0 ? [] : items.slice(at + 1)) {
    if (item.kind === "user" || item.kind === "report" || item.kind === "botMessage") break;
    keys.add(itemKey(item));
  }
  if (keys.size > 0) return keys;
  const started = items.find((i) => i.kind === "task" && i.sessionId === sessionId);
  return new Set(started ? [itemKey(started)] : []);
}

/// An item's React key, as the chat draws it.
export const itemKey = (item: BotItem): string => ("key" in item ? item.key : item.event.id);

/// How `nudge_bot` opens every nudge it sends.
const NUDGE = "Stall nudge:";
