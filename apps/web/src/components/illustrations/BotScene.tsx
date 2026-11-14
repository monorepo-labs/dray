"use client";

import { Fragment, useEffect, useRef, useState } from "react";

import {
  BotBubble,
  BotComposer,
  BotRow,
  LearnedLine,
  MergeCard,
  MergeControl,
  SentBubble,
  TaskBreak,
  TaskLine,
  TaskRow,
  TimeLabel,
  WaitingCard,
  WaitingRow,
  type Avatar,
  type Pr,
} from "@/components/app/Bot";
import Orb from "@/components/app/Orb";
import s from "./Hero.module.css";

/// Three bots, the bots-video demo's: Dray, Ops and Docs, with its faces.
export const BOTS = [
  { id: "b0000001", name: "Dray", avatar: { shape: "cloud", hue: 80 } },
  { id: "b0000002", name: "Ops", avatar: { shape: "hexagon", hue: 200 } },
  { id: "b0000003", name: "Docs", avatar: { shape: "round", hue: 320 } },
] as const satisfies { id: string; name: string; avatar: Avatar }[];

export type BotId = (typeof BOTS)[number]["id"];

/// Session ids in the demo's own shape, so each task wears the face the app
/// seeds for it there.
const sid = (n: number) => `019a7c00-0000-7000-8000-${String(n).padStart(12, "0")}`;

type Item =
  | { kind: "time"; text: string }
  | { kind: "you"; text: string }
  | { kind: "bot"; text: string }
  | { kind: "started" | "messaged"; task: string }
  | { kind: "learned"; lesson: string; summary: string }
  | { kind: "card"; task: string };

type Task = {
  id: string;
  title: string;
  working?: boolean;
  pr?: Pr;
  fixing?: string;
  /// Sat on the reader with a PR ready, so it joins "Waiting on you".
  stalled?: string;
  /// What it needs, in the line its bot wrote for it.
  need?: { text: string; age: string };
  /// Merged from the chat or the tab: the bot tidies it away.
  settled?: boolean;
};

type BotState = {
  items: Item[];
  tasks: Task[];
  working: boolean;
  unread: number;
  time: string;
  dismissed: boolean;
};

const CHANGELOG = sid(17);

function initial(): Record<BotId, BotState> {
  return {
    b0000001: {
      items: [
        { kind: "time", text: "Today 09:40" },
        { kind: "you", text: "Can you write the 0.42 changelog? The release goes out today." },
        { kind: "started", task: CHANGELOG },
        { kind: "bot", text: "Writing it now. It covers everything merged since 0.41: Shiki 3.2, the sidebar fixes, Cloud machines." },
        { kind: "you", text: "From now on, end every changelog line with its PR number." },
        { kind: "bot", text: "Will do. It's a rule now, so every changelog task gets it. I passed it on to this one." },
        { kind: "learned", lesson: "Rule", summary: "End every changelog line with its PR number, like (#1015)." },
        { kind: "messaged", task: CHANGELOG },
        { kind: "bot", text: "The 0.42 changelog is ready." },
        { kind: "card", task: CHANGELOG },
      ],
      tasks: [
        { id: sid(12), title: "Fix the flaky worktree test", working: true, pr: { number: 1010, state: "open", failing: true }, fixing: "Fixing failing checks · 4m" },
        { id: sid(14), title: "Settings: search box for shortcuts", working: true, pr: { number: 1013, state: "draft" } },
        { id: CHANGELOG, title: "Write the 0.42 changelog", pr: { number: 1015, state: "open" } },
        { id: sid(16), title: "Cloud: name the machine in the titlebar", pr: { number: 1012, state: "open" }, stalled: "40m" },
        { id: sid(13), title: "Island: quieter send sound", pr: { number: 1011, state: "open", running: true } },
        {
          id: sid(15),
          title: "iOS: bot chats in the session list",
          need: { text: "Should bot chats sit above or below projects in the iOS list?", age: "7m" },
        },
        { id: sid(11), title: "Bump Shiki to 3.2", pr: { number: 1009, state: "merged" } },
      ],
      working: false,
      unread: 0,
      time: "2m",
      dismissed: false,
    },
    b0000002: {
      items: [
        { kind: "time", text: "Today 11:05" },
        { kind: "you", text: "Ship 0.41.2 on all three channels." },
        { kind: "started", task: sid(31) },
        { kind: "bot", text: "0.41.2 is out on all three channels. Notarized in 4 minutes." },
      ],
      tasks: [{ id: sid(31), title: "Release 0.41.2" }],
      working: false,
      unread: 1,
      time: "34m",
      dismissed: false,
    },
    b0000003: {
      items: [
        { kind: "time", text: "Today 10:20" },
        { kind: "you", text: "The Spaces page still shows the old project picker." },
        { kind: "started", task: sid(41) },
        { kind: "bot", text: "Updated the Spaces page for the new project filter." },
      ],
      tasks: [{ id: sid(41), title: "Docs: Spaces page for the project filter", pr: { number: 1007, state: "merged" } }],
      working: false,
      unread: 0,
      time: "1h",
      dismissed: false,
    },
  };
}

/// What a bot says on taking a message it never reads. Written to fit any.
const TAKEN = [
  "On it. I started a task for that and will post its PR here when it can land.",
  "Started. It runs in a worktree of its own, so nothing else moves.",
  "Got it. A task has it now; I'll check its PR before I hand it to you.",
];

/// A task's title from the message that started it: its first sentence.
function titleOf(prompt: string): string {
  const first = prompt.split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, "").trim();
  const title = first.charAt(0).toUpperCase() + first.slice(1);
  return title.length > 48 ? `${title.slice(0, 47).trimEnd()}…` : title;
}

/// The bots' side of the hero: their rows, chats and Tasks tabs, and the two
/// things a visitor can do there — merge a PR, and send a bot a message,
/// which it answers by starting a task that later posts its own PR.
export function useBotScene() {
  const [bots, setBots] = useState(initial);
  const [merging, setMerging] = useState<ReadonlySet<number>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const sent = useRef(0);

  useEffect(() => {
    const live = timers.current;
    return () => live.forEach(clearTimeout);
  }, []);

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  };

  const update = (bot: BotId, fn: (state: BotState) => BotState) =>
    setBots((all) => ({ ...all, [bot]: fn(all[bot]) }));

  const read = (bot: BotId) => update(bot, (b) => (b.unread ? { ...b, unread: 0 } : b));

  /// Lands a PR wherever it is shown: card, Tasks tab and "Waiting on you"
  /// share it. Merging from a bot settles the task, as the app does.
  const confirm = (bot: BotId, pr: number) => {
    setMerging((all) => new Set(all).add(pr));
    later(900, () => {
      setMerging((all) => new Set([...all].filter((n) => n !== pr)));
      update(bot, (b) => ({
        ...b,
        tasks: b.tasks.map((t) =>
          t.pr?.number === pr ? { ...t, settled: true, pr: { ...t.pr, state: "merged" as const } } : t,
        ),
      }));
    });
  };

  const send = (bot: BotId) => {
    const prompt = (drafts[bot] ?? "").trim();
    if (!prompt) return;
    const n = sent.current++;
    const task = sid(60 + n);
    const title = titleOf(prompt);
    setDrafts((all) => ({ ...all, [bot]: "" }));
    update(bot, (b) => ({ ...b, items: [...b.items, { kind: "you", text: prompt }], working: true, time: "now" }));
    later(900, () =>
      update(bot, (b) => ({
        ...b,
        items: [...b.items, { kind: "started", task }],
        tasks: [{ id: task, title, working: true }, ...b.tasks],
      })),
    );
    later(2200, () =>
      update(bot, (b) => ({ ...b, items: [...b.items, { kind: "bot", text: TAKEN[n % TAKEN.length] }], working: false })),
    );
    // Its PR turns ready a while later, and the bot posts the card.
    later(6500, () =>
      update(bot, (b) => ({
        ...b,
        items: [...b.items, { kind: "bot", text: `${title} is ready.` }, { kind: "card", task }],
        tasks: b.tasks.map((t) => (t.id === task ? { ...t, working: false, pr: { number: 1046 + n, state: "open" } } : t)),
        time: "now",
      })),
    );
  };

  return {
    bots,
    merging,
    drafts,
    read,
    setDraft: (bot: BotId, text: string) => setDrafts((all) => ({ ...all, [bot]: text })),
    send,
    confirm,
    dismiss: (bot: BotId) => update(bot, (b) => ({ ...b, dismissed: true })),
  };
}

export type BotScene = ReturnType<typeof useBotScene>;

/// The sidebar's bot rows: the last reply under each name, typing dots while
/// it works.
export function BotRows({
  scene,
  selected,
  onOpen,
}: {
  scene: BotScene;
  selected: string | null;
  onOpen: (bot: BotId) => void;
}) {
  return BOTS.map((bot) => {
    const state = scene.bots[bot.id];
    const last = [...state.items].reverse().find((i) => i.kind === "bot");
    return (
      <BotRow
        key={bot.id}
        name={bot.name}
        seed={bot.id}
        avatar={bot.avatar}
        time={state.time}
        preview={last?.kind === "bot" ? last.text : ""}
        working={state.working}
        unread={state.unread}
        active={selected === bot.id}
        onClick={() => onOpen(bot.id)}
      />
    );
  });
}

/// A bot's chat, both sides as bubbles, anchored to its newest line the way a
/// messenger opens: older lines run off the top.
export function BotChat({ scene, bot }: { scene: BotScene; bot: BotId }) {
  const state = scene.bots[bot];
  const taskOf = (id: string) => state.tasks.find((t) => t.id === id);
  const waiting = state.dismissed ? [] : state.tasks.filter((t) => !t.settled && (t.stalled || t.need));

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 pt-6 pb-6">
          {state.items.map((item, i) => {
            const prev = state.items[i - 1];
            const key = `${i}-${item.kind}`;
            switch (item.kind) {
              case "time":
                return <TimeLabel key={key}>{item.text}</TimeLabel>;
              case "you":
                return (
                  <Enter key={key} fresh={i >= INITIAL[bot]}>
                    <SentBubble>{item.text}</SentBubble>
                  </Enter>
                );
              case "bot":
                return (
                  <Enter key={key} fresh={i >= INITIAL[bot]} self>
                    <BotBubble tight={prev?.kind === "bot"}>{item.text}</BotBubble>
                  </Enter>
                );
              case "started":
              case "messaged":
                return (
                  <Enter key={key} fresh={i >= INITIAL[bot]} self>
                    <TaskLine
                      verb={item.kind === "started" ? "Started a new task" : "Messaged"}
                      id={item.task}
                      title={taskOf(item.task)?.title ?? "Task"}
                    />
                  </Enter>
                );
              case "learned":
                return <LearnedLine key={key} kind={item.lesson} summary={item.summary} />;
              case "card": {
                const task = taskOf(item.task);
                if (!task?.pr) return null;
                const n = task.pr.number;
                return (
                  <Enter key={key} fresh={i >= INITIAL[bot]} self>
                    <MergeCard
                      taskId={task.id}
                      title={task.title}
                      pr={task.pr}
                      merging={scene.merging.has(n)}
                      onConfirm={() => scene.confirm(bot, n)}
                    />
                  </Enter>
                );
              }
            }
          })}
          {state.working && (
            <div className="flex items-center gap-2">
              <Orb />
              <span className="shimmer-text min-w-0 truncate text-chat">Working</span>
            </div>
          )}
          {waiting.length > 0 && (
            <WaitingCard onDismiss={() => scene.dismiss(bot)}>
              {waiting.map((t) => (
                <WaitingRow
                  key={t.id}
                  id={t.id}
                  title={t.title}
                  pr={t.stalled ? t.pr : undefined}
                  age={t.stalled ?? t.need?.age ?? ""}
                  need={t.need?.text}
                  merge={t.stalled && t.pr && <Merge scene={scene} bot={bot} pr={t.pr.number} />}
                />
              ))}
            </WaitingCard>
          )}
        </div>
      </div>
      <BotComposer
        value={scene.drafts[bot] ?? ""}
        onChange={(text) => scene.setDraft(bot, text)}
        onSend={() => scene.send(bot)}
      />
    </>
  );
}

/// How many lines each chat opens with: anything past them is the visitor's
/// own doing and eases in.
const INITIAL = Object.fromEntries(Object.entries(initial()).map(([id, b]) => [id, b.items.length])) as Record<BotId, number>;

function Enter({ fresh, self = false, children }: { fresh: boolean; self?: boolean; children: React.ReactNode }) {
  if (!fresh) return children;
  // A wrapper would take the row's own `self-start` away, so it carries it.
  return <div className={`${s.enter} ${self ? "flex flex-col items-start" : ""}`}>{children}</div>;
}

function Merge({ scene, bot, pr }: { scene: BotScene; bot: BotId; pr: number }) {
  return (
    <MergeControl
      merging={scene.merging.has(pr)}
      onConfirm={() => scene.confirm(bot, pr)}
    />
  );
}

/// The bot's Tasks tab: what works first, a break, then what is done. A
/// task settled after its merge leaves the list.
export function BotTasks({ scene, bot }: { scene: BotScene; bot: BotId }) {
  const tasks = scene.bots[bot].tasks.filter((t) => !t.settled);
  const runs = [tasks.filter((t) => t.working), tasks.filter((t) => !t.working)].filter((run) => run.length);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-1 py-2">
      {runs.map((run, i) => (
        <Fragment key={i}>
          {i > 0 && <TaskBreak />}
          {run.map((t) => (
            <TaskRow
              key={t.id}
              id={t.id}
              title={t.title}
              working={t.working ? <Orb /> : undefined}
              pr={t.pr}
              fixing={t.fixing}
              merge={
                t.pr?.state === "open" && !t.pr.failing && !t.pr.running && <Merge scene={scene} bot={bot} pr={t.pr.number} />
              }
            />
          ))}
        </Fragment>
      ))}
    </div>
  );
}
