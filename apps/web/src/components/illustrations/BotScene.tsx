"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Globe } from "lucide-react";

import {
  BotBubble,
  BotComposer,
  BotFace,
  BotRow,
  MachineMark,
  MergeCard,
  SentBubble,
  TaskBreak,
  TaskLine,
  TaskRow,
  TimeLabel,
  VideoPlayer,
  WaitingCard,
  WaitingRow,
  type Avatar,
  type Pr,
} from "@/components/app/Bot";
import { AssistantText, Composer, ToolGroup, Transcript, Turn, UserBubble } from "@/components/app/Chat";
import Orb from "@/components/app/Orb";
import { AddTab, ChatIcon, ItemTab } from "@/components/app/Tabs";
import { ClaudeGlyph } from "@/components/ClaudeGlyph";
import s from "./Hero.module.css";

/// Two bots, faces from the bots-video demo: Dray, and Ops beside it.
export const BOTS = [
  { id: "b0000001", name: "Dray", avatar: { shape: "cloud", hue: 80 } },
  { id: "b0000002", name: "Ops", avatar: { shape: "hexagon", hue: 200 } },
] as const satisfies { id: string; name: string; avatar: Avatar }[];

export type BotId = (typeof BOTS)[number]["id"];

/// Session ids in the demo's own shape, so each task wears the face the app
/// seeds for it there.
const sid = (n: number) => `019a7c00-0000-7000-8000-${String(n).padStart(12, "0")}`;

type Item =
  | { kind: "time"; text: string }
  | { kind: "you"; text: string }
  /// `video`: a recording the bot sent with its words, played under them.
  | { kind: "bot"; text: string; video?: string }
  | { kind: "started"; task: string }
  | { kind: "card"; task: string };

export type Task = {
  id: string;
  title: string;
  /// The worktree's name, which the titlebar shows while the task is lit.
  branch: string;
  /// What it changed, for its panel's Changes tab.
  changes: { dir: string; name: string; added: number; removed: number }[];
  /// Its to-do list, for its panel's More tab.
  todos: { text: string; done: boolean }[];
  /// What the bot told it, which opens its own chat.
  brief: string;
  tools: string;
  /// Its last reply; none while it is still on its first turn.
  report?: string;
  working?: boolean;
  /// Runs on another machine: the server mark on its row and tab.
  machine?: boolean;
  pr?: Pr;
  /// What it needs, in the line its bot wrote for it: "Waiting on you".
  need?: { text: string; age: string };
  /// Merged from the chat or the tab: the bot tidies it away.
  settled?: boolean;
};

/// The chat, a page in the bot's browser, or one of its tasks by id.
type View = "chat" | "browser" | string;

type BotState = {
  items: Item[];
  tasks: Task[];
  /// Replies still owed, one per message sent: the dots run until the last.
  pending: number;
  unread: number;
  time: string;
  dismissed: boolean;
  /// Tasks open as tabs in the titlebar, in the order they were opened.
  tabs: string[];
  /// The page the bot's browser has open, if any.
  page?: string;
  view: View;
};

const CHANGELOG = sid(17);
const CLOUD = sid(16);
const IOS = sid(15);

function initial(): Record<BotId, BotState> {
  return {
    b0000001: {
      items: [
        { kind: "you", text: "Write the 0.42 changelog for today's release." },
        { kind: "started", task: CHANGELOG },
        { kind: "card", task: CHANGELOG },
        { kind: "bot", text: "Checked it on the site. Every line has its PR.", video: "/bots/changelog-0.42.mp4" },
      ],
      tasks: [
        {
          id: sid(12),
          title: "Fix the flaky worktree test",
          branch: "steady-fern-ridge",
          changes: [{ dir: "src-tauri/src/", name: "worktree.rs", added: 18, removed: 6 }, { dir: "src-tauri/src/", name: "git.rs", added: 4, removed: 1 }],
          todos: [{ text: "Reproduce the failure", done: true }, { text: "Find the race in remove_session_worktree", done: true }, { text: "Hold the lock across the removal", done: false }, { text: "Run the test 50 times", done: false }],
          brief: "The worktree test fails about one run in five. Find the race and fix it.",
          tools: "8 tool calls",
          working: true,
        },
        {
          id: CLOUD,
          title: "Cloud: name the machine in the titlebar",
          branch: "north-quiet-cove",
          changes: [{ dir: "src/components/layout/", name: "ViewTabs.tsx", added: 22, removed: 3 }, { dir: "src/lib/", name: "servers.ts", added: 9, removed: 0 }],
          todos: [{ text: "Read the machine off the session", done: true }, { text: "Draw it at the titlebar's end", done: false }, { text: "Check it on a Cloud task", done: false }],
          brief: "Show the machine a Cloud task runs on in its titlebar.",
          tools: "5 tool calls",
          working: true,
          machine: true,
        },
        {
          id: CHANGELOG,
          title: "Write the 0.42 changelog",
          branch: "amber-quiet-delta",
          changes: [{ dir: "apps/desktop/", name: "CHANGELOG.md", added: 14, removed: 0 }],
          todos: [{ text: "Collect the PRs merged since 0.41", done: true }, { text: "Write one line each", done: true }, { text: "End every line with its PR number", done: true }, { text: "Open a PR", done: true }],
          brief: "Write the 0.42 changelog from everything merged since 0.41. End every line with its PR number.",
          tools: "12 tool calls · 1 file changed",
          report: "Done. CHANGELOG.md has 14 lines under 0.42, each ending with its PR number. PR #1015 is up and checks pass.",
          pr: { number: 1015, state: "open" },
        },
        {
          id: sid(13),
          title: "Island: quieter send sound",
          branch: "pale-iron-harbor",
          changes: [{ dir: "apps/island/Sources/", name: "SendSound.swift", added: 3, removed: 3 }],
          todos: [{ text: "Find where the send sound plays", done: true }, { text: "Halve its gain", done: true }, { text: "Open a PR", done: true }],
          brief: "The island's send sound is too loud. Bring it down by half.",
          tools: "6 tool calls · 1 file changed",
          report: "Halved the send sound's gain. PR #1011 is up; checks are running.",
          machine: true,
          pr: { number: 1011, state: "open", running: true },
        },
        {
          id: IOS,
          title: "iOS: bot chats in the session list",
          branch: "brisk-jade-cove",
          changes: [{ dir: "apps/ios/Sources/", name: "SessionList.swift", added: 48, removed: 6 }, { dir: "apps/ios/Sources/", name: "BotRow.swift", added: 61, removed: 0 }, { dir: "apps/ios/Sources/", name: "Models.swift", added: 12, removed: 2 }],
          todos: [{ text: "Decode bots from the serve wire", done: true }, { text: "Draw a row per bot chat", done: true }, { text: "Place bot chats in the list", done: false }],
          brief: "Show bot chats in the iOS session list.",
          tools: "9 tool calls · 3 files changed",
          report: "Bot chats show in the list now. One question before I place them: above or below projects?",
          need: { text: "Should bot chats sit above or below projects in the iOS list?", age: "7m" },
        },
      ],
      pending: 0,
      unread: 0,
      time: "2m",
      dismissed: false,
      tabs: [CHANGELOG, CLOUD],
      page: "localhost:3000",
      view: "chat",
    },
    b0000002: {
      items: [
        { kind: "time", text: "Today 11:05" },
        { kind: "you", text: "Ship 0.41.2 on all three channels." },
        { kind: "started", task: sid(31) },
        { kind: "bot", text: "0.41.2 is out on all three channels. Notarized in 4 minutes." },
      ],
      tasks: [
        {
          id: sid(31),
          title: "Release 0.41.2",
          branch: "calm-owl-ridge",
          changes: [{ dir: "apps/desktop/", name: "CHANGELOG.md", added: 6, removed: 0 }, { dir: "apps/desktop/src-tauri/", name: "tauri.conf.json", added: 1, removed: 1 }],
          todos: [{ text: "Bump the version", done: true }, { text: "Tag cli-v0.41.2", done: true }, { text: "Publish on all three channels", done: true }],
          brief: "Ship 0.41.2 on stable, beta and nightly.",
          tools: "14 tool calls",
          report: "0.41.2 is out on all three channels. Notarized in 4 minutes.",
        },
      ],
      pending: 0,
      unread: 1,
      time: "34m",
      dismissed: false,
      tabs: [],
      view: "chat",
    },
  };
}

/// Worktree names for tasks a visitor's message starts.
const BRANCHES = ["calm-owl-ridge", "quiet-lime-fen", "bold-sage-reef", "bright-moss-bay"];

/// Task tabs the titlebar keeps open beside the chat and the page.
const TASK_TABS = 3;

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

/// The bots' side of the hero: their rows, chats, tabs and Tasks tabs, and
/// what a visitor can do there — merge a PR, open a task, and send a bot a
/// message, which it answers by starting a task that later posts its own PR.
/// `selected` is read when a reply lands, which is after the render that
/// sent it, so a reply arriving in a chat the visitor left counts as unread.
export function useBotScene(selected: string) {
  const [bots, setBots] = useState(initial);
  const [merging, setMerging] = useState<ReadonlySet<number>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const sent = useRef(0);
  const shown = useRef(selected);
  useEffect(() => {
    shown.current = selected;
  }, [selected]);

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

  /// A bot's reply: unread unless its chat is on screen.
  const reply = (bot: BotId, b: BotState, items: Item[]): BotState => ({
    ...b,
    items: [...b.items, ...items],
    time: "now",
    unread: shown.current === bot && b.view === "chat" ? 0 : b.unread + 1,
  });


  /// Lands a PR wherever it is shown: card and Tasks tab share it. Merging
  /// from a bot settles the task, as the app does.
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
    const pr = 1046 + n;
    setDrafts((all) => ({ ...all, [bot]: "" }));
    update(bot, (b) => ({ ...b, items: [...b.items, { kind: "you", text: prompt }], pending: b.pending + 1, time: "now" }));
    later(900, () =>
      update(bot, (b) => ({
        ...b,
        items: [...b.items, { kind: "started", task }],
        tasks: [
          {
            id: task,
            title,
            brief: prompt,
            tools: "4 tool calls",
            working: true,
            branch: BRANCHES[n % BRANCHES.length],
            changes: [],
            todos: [
              { text: "Read the code it touches", done: true },
              { text: "Make the change", done: false },
              { text: "Check it in the browser", done: false },
            ],
          },
          ...b.tasks,
        ],
      })),
    );
    later(2200, () =>
      update(bot, (b) => ({ ...reply(bot, b, [{ kind: "bot", text: TAKEN[n % TAKEN.length] }]), pending: b.pending - 1 })),
    );
    // Its PR turns ready a while later, and the bot posts the card.
    later(6500, () =>
      update(bot, (b) => ({
        ...reply(bot, b, [{ kind: "bot", text: `${title} is ready.` }, { kind: "card", task }]),
        tasks: b.tasks.map((t) =>
          t.id === task
            ? {
                ...t,
                working: false,
                tools: "11 tool calls · 2 files changed",
                changes: [
                  { dir: "src/components/", name: "Settings.tsx", added: 34, removed: 5 },
                  { dir: "src/lib/", name: "prefs.ts", added: 8, removed: 1 },
                ],
                todos: t.todos.map((todo) => ({ ...todo, done: true })),
                report: `Done. PR #${pr} is up and checks pass.`,
                pr: { number: pr, state: "open" },
              }
            : t,
        ),
      })),
    );
  };

  /// Opens a task in the titlebar, as a tab of its own if it has none yet.
  /// The newest `TASK_TABS` stay: the drawn strip neither scrolls nor shrinks
  /// a tab to its icon, so more would push the page's tab out of reach.
  const openTask = (bot: BotId, task: string) =>
    update(bot, (b) => ({
      ...b,
      tabs: b.tabs.includes(task) ? b.tabs : [...b.tabs, task].slice(-TASK_TABS),
      view: task,
    }));

  const show = (bot: BotId, view: View) =>
    update(bot, (b) => ({ ...b, view, unread: view === "chat" ? 0 : b.unread }));

  return {
    bots,
    merging,
    drafts,
    setDraft: (bot: BotId, text: string) => setDrafts((all) => ({ ...all, [bot]: text })),
    send,
    confirm,
    openTask,
    show,
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
        working={state.pending > 0}
        unread={state.unread}
        active={selected === bot.id}
        onClick={() => onOpen(bot.id)}
      />
    );
  });
}

/// A bot's row of tabs: its chat, the tasks it has open, then its browser's
/// page. A chat with nothing beside it is a title.
export function BotTabs({ scene, bot, name }: { scene: BotScene; bot: BotId; name: string }) {
  const state = scene.bots[bot];
  const open = state.tabs.map((id) => state.tasks.find((t) => t.id === id)).filter((t) => t !== undefined);
  if (!state.page && open.length === 0) return <ItemTab icon={<ChatIcon />} label={name} plain />;
  return (
    <>
      <ItemTab
        // Off the chat, its tab is what says the bot is working.
        icon={state.pending > 0 && state.view !== "chat" ? <Orb size={16} /> : <ChatIcon />}
        label={name}
        active={state.view === "chat"}
        onClick={() => scene.show(bot, "chat")}
      />
      {open.map((t) => (
        <ItemTab
          key={t.id}
          icon={t.working ? <Orb size={16} /> : <BotFace still seed={t.id} className="block size-4 shrink-0 scale-[1.18]" />}
          label={t.title}
          trailing={t.machine && <MachineMark />}
          active={state.view === t.id}
          onClick={() => scene.openTask(bot, t.id)}
        />
      ))}
      {state.page && (
        <ItemTab
          icon={<Globe className="size-3.5 shrink-0 text-muted-foreground" />}
          label={state.page}
          active={state.view === "browser"}
          onClick={() => scene.show(bot, "browser")}
        />
      )}
      <AddTab />
    </>
  );
}

/// What the bot's tab row has lit: its chat, a task's own chat, or the page.
export function BotMain({ scene, bot, browser }: { scene: BotScene; bot: BotId; browser: ReactNode }) {
  const state = scene.bots[bot];
  if (state.view === "chat") return <BotChat scene={scene} bot={bot} />;
  if (state.view === "browser") return browser;
  const task = state.tasks.find((t) => t.id === state.view);
  return task ? <TaskChat key={task.id} task={task} /> : <BotChat scene={scene} bot={bot} />;
}

/// A task's own chat: an ordinary session, opened on what its bot told it,
/// with the ordinary composer and its row of pickers under it.
function TaskChat({ task }: { task: Task }) {
  return (
    <>
      <Transcript>
        <Turn>
          <UserBubble>{task.brief}</UserBubble>
          <ToolGroup label={task.tools} />
          {task.report && <AssistantText>{task.report}</AssistantText>}
          {task.working && (
            <div className="flex h-6 items-center">
              <Orb />
            </div>
          )}
        </Turn>
      </Transcript>
      <Composer
        placeholder="Follow-up. @files. /skills. &tasks. #issues."
        mic
        agent={<ClaudeGlyph className="size-3.5" />}
        model="Opus 5.5"
        effort="High"
        mode="Auto"
        context={0.22}
      />
    </>
  );
}

/// A bot's chat, both sides as bubbles: from the top while it fits, then
/// pinned to its newest line as the app's is, older lines running off the top.
function BotChat({ scene, bot }: { scene: BotScene; bot: BotId }) {
  const state = scene.bots[bot];
  const taskOf = (id: string) => state.tasks.find((t) => t.id === id);
  const waiting = state.dismissed ? [] : state.tasks.filter((t) => !t.settled && t.need);
  const scroller = useRef<HTMLDivElement>(null);
  // Every render: anything new lands at the foot. `scrollTop` moves even an
  // `overflow-hidden` box, which keeps the page's wheel off the drawing.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  return (
    <>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-hidden">
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
                    <BotBubble tight={prev?.kind === "bot"}>
                      {item.text}
                      {item.video && <VideoPlayer src={item.video} className="max-h-44" />}
                    </BotBubble>
                  </Enter>
                );
              case "started":
                return (
                  <Enter key={key} fresh={i >= INITIAL[bot]} self>
                    <TaskLine
                      id={item.task}
                      title={taskOf(item.task)?.title ?? "Task"}
                      onClick={() => scene.openTask(bot, item.task)}
                    />
                  </Enter>
                );
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
          {state.pending > 0 && (
            <div className="flex items-center gap-2">
              <Orb />
              <span className="shimmer-text min-w-0 truncate text-chat">Working</span>
            </div>
          )}
        </div>
      </div>
      {/* Held at the foot, right above the composer, whatever the chat holds. */}
      {waiting.length > 0 && (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-3">
          <WaitingCard onDismiss={() => scene.dismiss(bot)}>
            {waiting.map((t) => (
              <WaitingRow key={t.id} id={t.id} title={t.title} age={t.need?.age ?? ""} need={t.need?.text} />
            ))}
          </WaitingCard>
        </div>
      )}
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

function Enter({ fresh, self = false, children }: { fresh: boolean; self?: boolean; children: ReactNode }) {
  if (!fresh) return children;
  // A wrapper would take the row's own `self-start` away, so it carries it.
  return <div className={`${s.enter} ${self ? "flex flex-col items-start" : ""}`}>{children}</div>;
}

/// The bot's Tasks tab: what works first, a break, then the rest, one line
/// each. A task settled after its merge leaves the list; a click opens one.
export function BotTasks({ scene, bot }: { scene: BotScene; bot: BotId }) {
  const tasks = scene.bots[bot].tasks.filter((t) => !t.settled);
  const runs = [tasks.filter((t) => t.working), tasks.filter((t) => !t.working)].filter((run) => run.length);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-1 py-2">
      {runs.map((run, i) => (
        <Fragment key={i}>
          {i > 0 && <TaskBreak />}
          {/* No Merge here: the card in the chat is where a PR lands. */}
          {run.map((t) => (
            <TaskRow
              key={t.id}
              id={t.id}
              title={t.title}
              working={t.working ? <Orb /> : undefined}
              machine={t.machine}
              pr={t.pr}
              onOpen={() => scene.openTask(bot, t.id)}
            />
          ))}
        </Fragment>
      ))}
    </div>
  );
}
