import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import BotAvatar from "@/components/BotAvatar";
import EventRow from "@/components/chat/EventRow";
import UserMessage from "@/components/chat/UserMessage";
import { OrbLine } from "@/components/chat/WorkingIndicator";
import { useStreamingBlock, useStreamingKind } from "@/hooks/useStreamingBlock";
import { seededAvatar } from "@/lib/botAvatar";
import { botNamed, useBots } from "@/lib/bots";
import {
  botRows,
  chatItems,
  chatTime,
  firstUnread,
  itemKey,
  itemTime,
  startsTimeRun,
  taskContext,
  type BotSegment,
  type TalkItem,
} from "@/lib/botTranscript";
import { AGENT_LABELS } from "@/lib/model";
import { isModClick } from "@/lib/platform";
import { stripSenderPrefix } from "@/lib/relay";
import { streamingCall } from "@/lib/streaming";
import { streamingLabel, toolArgument, toolLabel } from "@/lib/tools";
import { cn } from "@/lib/utils";
import type { AgentEvent, Bot, BotAvatar as Avatar, Harness, ToolResult } from "@/types/events";

/// A task a bot started, as its card names it.
/// A task as its chat draws it. `sessionId` is the full id, since the bot may
/// have named the task by a prefix of it.
export type BotTask = { sessionId: string; title: string };
type TaskOf = (sessionId: string) => BotTask | undefined;

const NO_RESULTS = new Map<string, ToolResult>();

/// A bot's chat: the conversation and the tasks it started, and while it works
/// one line naming what it is doing — the only place its tool calls show.
export default function BotTranscript({
  segments,
  busy,
  preview,
  unread,
  taskOf,
  onOpenSession,
  onOpenBot,
  focus,
}: {
  /// The chat had unread replies when opened. Read once: opening it clears
  /// the state, and the divider has to stay where it was.
  unread: boolean;
  /// Every session of the chat, oldest first; the last is the one running.
  segments: readonly BotSegment[];
  busy: boolean;
  /// The open streaming block. Drawn only while it is reply text.
  preview?: ReactNode;
  taskOf?: (sessionId: string) => BotTask | undefined;
  /// `alone`: a ⌘-click, which switches to a task rather than opening its tab.
  onOpenSession: (sessionId: string, alone?: boolean) => void;
  onOpenBot?: (bot: Bot) => void;
  /// A task picked from the "Waiting on you" card: the bot's reply to its last
  /// report is lit for a moment under `data-bot-focus`, which the chat scrolls
  /// to. `at` tells a second pick of the same task apart.
  focus?: { sessionId: string; at: number } | null;
}) {
  const bots = useBots();
  const items = useMemo(() => chatItems(segments), [segments]);
  const events = segments.at(-1)?.events;
  // "From" rows, a task's messages to the bot, are hidden for now: the bot's
  // reply already says what came in. To draw them again, swap these back.
  // const rows = useMemo(() => botRows(items), [items]);
  const rows = useMemo(() => botRows(items.filter((i) => i.kind !== "report")), [items]);
  const context = useMemo(() => (focus ? taskContext(items, focus.sessionId) : null), [items, focus]);
  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (!focus) return;
    setLit(true);
    const off = setTimeout(() => setLit(false), 1600);
    return () => clearTimeout(off);
  }, [focus]);
  const [newFrom] = useState(() => (unread ? firstUnread(items) : null));
  const doing = useMemo(() => (busy && events ? currentTool(events) : null), [busy, events]);
  // Only reply text becomes a bubble. A tool call or a thought the model is
  // still composing would read as a message, so the orb line names it instead.
  const sessionId = segments.at(-1)?.sessionId ?? null;
  const streaming = useStreamingKind(sessionId);

  const drawn = rows.map((item, i) => {
        const key = "key" in item ? item.key : item.event.id;
        // A time label opens the chat and follows every pause, as a messenger's.
        const at = itemTime(item);
        const time = startsTimeRun(i === 0 ? null : itemTime(rows[i - 1]), at) && <TimeLabel at={at} />;
        return (
          <Fragment key={key}>
            {"event" in item && item.event.id === newFrom && <NewDivider />}
            {time}
            {item.kind === "switch" ? (
              <SwitchLine harness={item.harness} />
            ) : item.kind === "botMessage" ? (
              <>
                <BotLine
                  verb="Message from"
                  incoming
                  bot={bots.find((b) => b.id === item.botId)}
                  fallback={{ id: item.botId, title: item.title }}
                  onOpenBot={onOpenBot}
                />
                {item.event.payload.type === "user_message" && (
                  <UserMessage
                    eventId={item.event.id}
                    text={stripSenderPrefix(item.event.payload.text, item.event.payload.from)}
                    images={item.event.payload.images}
                    issues={item.event.payload.issues}
                    onOpenSession={onOpenSession}
                  />
                )}
              </>
            ) : item.kind === "botSent" ? (
              <BotLine
                verb="Messaged"
                bot={item.botId ? bots.find((b) => b.id === item.botId) : botNamed(bots, item.bot)}
                fallback={{ id: item.bot, title: item.bot }}
                onOpenBot={onOpenBot}
              />
            ) : item.kind === "talk" ? (
              <TalkLine items={item.items} taskOf={taskOf} onOpenSession={onOpenSession} />
            ) : item.kind === "task" ? (
              <StartedLine
                party={{ id: item.sessionId, title: taskOf?.(item.sessionId)?.title ?? "Task" }}
                onOpen={(alone) => onOpenSession(item.sessionId, alone)}
              />
            ) : item.kind === "assistant" ? (
              // Replies in a row sit close, as a messenger stacks them; a new
              // turn after the reader's message keeps the full gap.
              <BotBubble tight={!time && rows[i - 1]?.kind === "assistant"}>
                <EventRow event={item.event} resultByCallId={NO_RESULTS} onOpenSession={onOpenSession} />
              </BotBubble>
            ) : (
              <EventRow event={item.event} resultByCallId={NO_RESULTS} onOpenSession={onOpenSession} />
            )}
          </Fragment>
        );
  });
  // The picked task's rows sit in one block, so they light and scroll as one.
  const inContext = rows.map((row) =>
    row.kind === "talk" ? row.items.some((t) => context?.has(itemKey(t))) : !!context?.has(itemKey(row)),
  );
  const first = inContext.indexOf(true);
  const last = inContext.lastIndexOf(true);

  return (
    <>
      {first < 0 ? (
        drawn
      ) : (
        <>
          {drawn.slice(0, first)}
          <div
            data-bot-focus
            className={cn(
              "-mx-3 -my-2 flex flex-col gap-4 rounded-xl px-3 py-2 transition-colors duration-700",
              lit ? "bg-accent-command/12" : "bg-transparent",
            )}
          >
            {drawn.slice(first, last + 1)}
          </div>
          {drawn.slice(last + 1)}
        </>
      )}
      {busy &&
        (preview && streaming === "text" ? (
          <BotBubble tight={rows[rows.length - 1]?.kind === "assistant"}>{preview}</BotBubble>
        ) : (
          <OrbLine
            state="working"
            label={sessionId && streaming ? <StreamingActivity sessionId={sessionId} /> : (doing ?? "Working")}
          />
        ))}
    </>
  );
}

/// Who a line names: a task, by its session id, or a bot, with its own face.
type Party = { id: string; title: string; avatar?: Avatar | null };

/// The task a message went to or came from. A send may name its task by an id
/// prefix, which `taskOf` resolves.
function partyOf(item: TalkItem, taskOf: TaskOf | undefined): Party {
  if (item.kind === "report") {
    return { id: item.sessionId, title: taskOf?.(item.sessionId)?.title ?? item.title };
  }
  const task = taskOf?.(item.target);
  return { id: task?.sessionId ?? item.target, title: task?.title ?? "a task" };
}

/// A run of messages between the bot and its tasks, folded to one line naming
/// who and which way: "Messaged", "From", or "4 messages with" for a run
/// going both ways. The messages open beneath it on a click; folded, the
/// bot's own words around them carry what was said. Its tasks write on the
/// reader's side, where a relayed message lands, so a line with any of theirs
/// sits there too.
function TalkLine({
  items,
  bare = false,
  taskOf,
  onOpenSession,
}: {
  items: TalkItem[];
  /// Inside an opened run, whose line already says which way: no verb.
  bare?: boolean;
  taskOf: TaskOf | undefined;
  onOpenSession: (sessionId: string, alone?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const parties = [...new Map(items.map((i) => partyOf(i, taskOf)).map((p) => [p.id, p])).values()];
  const from = items.filter((i) => i.kind === "report").length;
  const verb = from === 0 ? "Messaged" : from < items.length ? `${items.length} messages with` : "From";
  const side = from > 0 ? "self-end" : "self-start";

  return (
    <>
      <div className={cn("flex max-w-full items-center gap-0.5 text-ui text-muted-foreground", side)}>
        {!bare && <span className="shrink-0">{verb}</span>}
        {/* One task opens on a click when the bot wrote to it: what it was told
            is in its own chat. Several open to their rows, and a task's own
            message opens to its text. */}
        {from === 0 && parties.length === 1 ? (
          <PartyChip parties={parties} onClick={(e) => onOpenSession(parties[0].id, isModClick(e))} />
        ) : (
          <PartyChip parties={parties} expanded={open} onClick={() => setOpen((o) => !o)} />
        )}
      </div>
      {/* A run opens to its messages' own lines, each folded in turn; only
          a single message opens to its text. */}
      {open &&
        (items.length > 1 ? (
          // Railed and indented as the transcript's own tool groups are, so the
          // messages read as belonging to the line above.
          <div
            className={cn(
              "flex w-full flex-col gap-1.5 border-border/60",
              from > 0 ? "items-end border-r pr-3" : "items-start border-l pl-3",
            )}
          >
            {items.map((item) => (
              <TalkLine
                key={item.kind === "report" ? item.event.id : item.key}
                items={[item]}
                bare
                taskOf={taskOf}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        ) : (
          items.map((item) =>
              item.kind === "report" ? (
                item.event.payload.type === "user_message" && (
                  // No `from`: the line above already names the task, with its face.
                  <UserMessage
                    key={item.event.id}
                    eventId={item.event.id}
                    text={stripSenderPrefix(item.event.payload.text, item.event.payload.from)}
                    images={item.event.payload.images}
                    issues={item.event.payload.issues}
                    onOpenSession={onOpenSession}
                  />
                )
              ) : (
                <div
                  key={item.key}
                  className="max-w-[85%] self-start rounded-2xl bg-muted px-3.5 py-2 text-chat whitespace-pre-wrap"
                >
                  {item.text}
                </div>
              ),
          )
        ))}
    </>
  );
}

/// Who a line is about: one task's face and name, or several faces stacked
/// and a count.
export function PartyChip({
  parties,
  expanded,
  onClick,
}: {
  parties: Party[];
  /// Set where the chip opens messages rather than a task.
  expanded?: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const single = parties.length === 1 ? parties[0] : null;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onClick}
      className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full py-0.5 pr-1.5 pl-1 transition-colors hover:bg-(--party-wash) hover:text-(--party-ink)"
      style={single ? partyColours(single) : NEUTRAL}
    >
      <span className="flex shrink-0 -space-x-2">
        {parties.slice(0, 3).map((p) => (
          <span key={p.id} className="size-5">
            <BotAvatar seed={p.id} avatar={p.avatar ?? seededAvatar(p.id)} className="block size-5 scale-[1.18]" />
          </span>
        ))}
      </span>
      <span className="truncate">{single ? single.title : `${parties.length} tasks`}</span>
    </button>
  );
}

const NEUTRAL = { "--party-wash": "var(--muted)", "--party-ink": "var(--foreground)" } as CSSProperties;

/// A party's name, on hover, in a pill of its own face's colour.
function partyColours(party: Party): CSSProperties {
  const { hue } = party.avatar ?? seededAvatar(party.id);
  return {
    "--party-wash": `oklch(0.7 0.12 ${hue} / 0.16)`,
    "--party-ink": `oklch(0.78 0.12 ${hue})`,
  } as CSSProperties;
}

/// The time a run of messages began, centred and quiet, as a messenger draws it.
function TimeLabel({ at }: { at: string }) {
  return <p className="self-center pt-2 text-[12px] text-muted-foreground/70">{chatTime(at)}</p>;
}

/// A bot's reply as a messenger draws the other side: a bubble on the left,
/// quieter than the reader's own card.
export function BotBubble({ tight = false, children }: { tight?: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "max-w-[85%] self-start rounded-xl bg-muted/50 px-3 py-2",
        tight && "-mt-2.5",
      )}
    >
      {children}
    </div>
  );
}

/// Where the chat moved to another agent, said as quietly as a time label.
function SwitchLine({ harness }: { harness: Harness }) {
  return <p className="self-center text-[12px] text-muted-foreground/70">Switched to {AGENT_LABELS[harness]}</p>;
}

/// Where the replies the reader has not seen begin, as a messenger marks it.
function NewDivider() {
  return (
    <div role="separator" aria-label="New messages" className="flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground">NEW</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/// What the bot is running now: the newest call of this turn with no result.
function currentTool(events: readonly AgentEvent[]): string | null {
  const done = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const { payload, subagent } = events[i];
    if (payload.type === "user_message" || payload.type === "turn_completed") return null;
    if (subagent) continue;
    if (payload.type === "tool_call_completed") done.add(payload.callId);
    if (payload.type === "tool_call_started" && !done.has(payload.callId)) {
      const arg = toolArgument(payload.input);
      return arg ? `${toolLabel(payload.name, true)} ${arg}` : toolLabel(payload.name, true);
    }
  }
  return null;
}

/// The open streaming block as the orb line's label: the tool being composed,
/// said as its preview row says it, or "Thinking". Its own component, since it
/// is the one that re-renders as the block grows.
function StreamingActivity({ sessionId }: { sessionId: string }) {
  const block = useStreamingBlock(sessionId);
  if (block?.type !== "tool_use" || !block.name) return "Thinking";
  const { target, added } = streamingCall(block.name, block.text);
  if (!target) return streamingLabel(block.name);
  return `${toolLabel(block.name, true)} ${target}${added ? ` +${added}` : ""}`;
}

/// A task the bot started, said the way its messages are: a line naming it,
/// which opens it. Whether it is still working is the Tasks tab's to say.
function StartedLine({ party, onOpen }: { party: Party; onOpen: (alone: boolean) => void }) {
  return (
    <div className="flex max-w-full items-center gap-0.5 self-start text-ui text-muted-foreground">
      <span className="shrink-0">Started a new task</span>
      <PartyChip parties={[party]} onClick={(e) => onOpen(isModClick(e))} />
    </div>
  );
}

/// A message between this bot and another: "Message from" on the side a
/// relayed message lands, "Messaged" on the bot's own. The name opens the
/// other bot's chat; one since deleted or renamed draws the name it was sent
/// under, with nothing to open.
function BotLine({
  verb,
  incoming = false,
  bot,
  fallback,
  onOpenBot,
}: {
  verb: string;
  incoming?: boolean;
  bot: Bot | undefined;
  fallback: Party;
  onOpenBot?: (bot: Bot) => void;
}) {
  // Seeded off the bot's id, as the sidebar's face is.
  const party = bot ? { id: bot.id, title: bot.name, avatar: bot.avatar ?? seededAvatar(bot.id) } : fallback;
  return (
    <div
      className={cn(
        "flex max-w-full items-center gap-0.5 text-ui text-muted-foreground",
        incoming ? "self-end" : "self-start",
      )}
    >
      <span className="shrink-0">{verb}</span>
      <PartyChip parties={[party]} onClick={() => bot && onOpenBot?.(bot)} />
    </div>
  );
}

/// Three dots taking turns, the way a messenger says the other side is typing.
export function TypingDots({ small = false }: { small?: boolean }) {
  return (
    <span
      role="img"
      aria-label="Working"
      className={cn("flex items-center", small ? "gap-0.5" : "h-[1lh] gap-1 text-ui")}
    >
      {[0, 160, 320].map((delay) => (
        <span
          key={delay}
          className={cn(
            "rounded-full bg-muted-foreground/70 motion-safe:animate-[typing-dot_1.2s_ease-in-out_infinite]",
            small ? "size-1" : "size-1.5",
          )}
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}
