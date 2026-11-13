import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";

import BotTranscript from "@/components/chat/BotTranscript";
import StalledTasks from "@/components/chat/StalledTasks";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import type { CrewRow } from "@/lib/crew";
import { compactAge, needLine, onCard, stalledTasks } from "@/lib/stalled";
import type { AgentEvent, PrMark, SessionIndexItem } from "@/types/events";
import "../App.css";

/// The stalled-tasks card at the foot of a bot's chat, run through the real
/// `stalledTasks` and `onCard` on made-up tasks: two PRs ready to merge, one of
/// them asking to be tried first, two idle tasks with a question, a PR waiting on review, one idle task the bot answers
/// itself, two PRs the task can mend (failing checks, a conflict), and three
/// left out — working, checks running, and idle only ten minutes. The card
/// starts with the ready PRs alone; every stall goes to the bot, listed under
/// the chat as the nudges the app sends. **Bot writes needs** lands the lines a
/// bot would write with `dray session need`, which puts the waiting tasks on
/// the card and a line under the ready PR that asked to be tried.
/// There is no server behind this page. Dismiss is stored for real; Reset
/// clears it.
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const row = (id: string, title: string, minutes: number, busy = false): CrewRow => ({
  item: {
    sessionId: `01a1d000-0000-7000-8000-00000000000${id}`,
    title,
    modified: ago(minutes),
    projectPath: "/repo",
    worktreeName: `task-${id}`,
  } as unknown as SessionIndexItem,
  busy,
  background: false,
  asking: false,
  unread: false,
});

const pr = (number: number, more: Partial<PrMark> = {}): PrMark => ({
  number,
  url: `https://github.com/acme/site/pull/${number}`,
  headRefName: "",
  isDraft: false,
  state: "OPEN",
  checksState: "CLEAR",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  ...more,
});

const ROWS: { row: CrewRow; pr?: PrMark; need?: string; answered?: boolean }[] = [
  { row: row("1", "Add a rename button to the session header", 50), need: "Pick: keep the button or drop it" },
  { row: row("2", "Move the session index to SQLite", 125), need: "Approve the SQLite migration plan as written" },
  { row: row("3", "Fix the pricing page copy", 40), pr: pr(908) },
  { row: row("a", "Show ⌥ hints on sidebar rows", 70), pr: pr(924), need: "Try the ⌥ hints in the dev app first" },
  {
    row: row("9", "Tighten the docs search ranking", 95),
    pr: pr(921, { mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }),
    need: "Review #921: it reorders search results",
  },
  // Idle on a question the bot can answer from what the reader already said.
  { row: row("0", "Write the release notes", 45), answered: true },
  { row: row("6", "Bump the Shiki version", 75), pr: pr(919, { checksState: "FAILING", mergeStateStatus: "UNSTABLE" }) },
  { row: row("7", "Rename the CLI flags", 50 * 60), pr: pr(917, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) },
  { row: row("8", "Audit the landing page", 90, true) },
  { row: row("4", "Add dark mode to docs", 60), pr: pr(916, { checksState: "RUNNING", mergeStateStatus: "BLOCKED" }) },
  { row: row("5", "Draft the onboarding email", 10) },
];

const BOT = "01a1cfc8-demo-stalled-bot";
let seq = 0;
const event = (payload: AgentEvent["payload"], minutes: number): AgentEvent => ({
  id: `e${seq}`,
  sessionId: BOT,
  harness: "claude_code",
  seq: seq++,
  ts: ago(minutes),
  turnId: null,
  subagent: null,
  payload,
});
const message = (text: string, minutes: number, from: string | null = null, image = false) =>
  event(
    {
      type: "user_message",
      text,
      images: image ? [{ path: null, url: SHOT, mimeType: "image/svg+xml" }] : [],
      issues: [],
      baseline: null,
      queued: false,
      from: from && { sessionId: from, title: ROWS.find((r) => r.row.item.sessionId === from)!.row.item.title, machine: null },
      cwd: null,
    } as AgentEvent["payload"],
    minutes,
  );
const say = (text: string, minutes: number) => event({ type: "assistant_text", block: null, text }, minutes);
const task = (id: string) => `01a1d000-0000-7000-8000-00000000000${id}`;

/// The header the rename task screenshotted, cramped at the narrowest width.
const SHOT = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="120"><rect width="1200" height="120" fill="#1b1b1b"/><text x="30" y="72" font-family="sans-serif" font-size="34" fill="#eee">Add a rena…</text><rect x="560" y="34" width="200" height="52" rx="12" fill="#2b2b2b"/><text x="590" y="70" font-family="monospace" font-size="26" fill="#999">main</text><rect x="790" y="34" width="150" height="52" rx="12" fill="#3a7bd5"/><text x="815" y="70" font-family="sans-serif" font-size="26" fill="#fff">Rename</text><rect x="970" y="34" width="190" height="52" rx="12" fill="#a33"/><text x="1020" y="70" font-family="sans-serif" font-size="26" fill="#fff">Stop</text></svg>`,
)}`;

const EVENTS: AgentEvent[] = [
  message("Five things for today: rename button in the header, SQLite for the session index, pricing copy, docs search ranking, release notes.", 180),
  say("On it. I started five tasks for that.", 179),
  message(
    "Here is the migration plan before I touch anything. 1. Add `rusqlite` behind the existing `store` API so no caller changes. 2. On first start, read `index.json` into a new `sessions.db`, keeping the JSON as a backup for one release. 3. Switch reads over, then drop the JSON writer. Should I go ahead with this plan as written?",
    125,
    task("2"),
  ),
  say("The SQLite task wants your go-ahead on its migration plan: three steps, JSON kept as a backup for one release. Say the word and it starts.", 124),
  message("Opened #921: search now ranks title matches above body matches. It changes the order of results, so it wants a review.", 95, task("9")),
  say("Docs search is up as #921. It reorders results, so it's waiting on your review.", 94),
  message(
    "I added the rename button and wired it to `rename_session`. At the narrowest width the title now truncates to eight characters (screenshot). Keep the button and hide the branch chip below 900px, or drop it and rely on double-clicking the title?",
    50,
    task("1"),
    true,
  ),
  say("The rename button works but crowds the header at narrow widths. Keep it and hide the branch chip, or drop it for double-click? Its screenshot shows the squeeze.", 49),
  message("Opened #908 with the new pricing copy. Checks pass and it's ready to merge.", 40, task("3")),
  say("Pricing copy is in #908 and ready to merge.", 39),
  message("Also, what does the release notes task need from me?", 30),
  say("Nothing yet, it's still drafting. I'll tell you when it has something.", 29),
];

function Demo() {
  const [rows, setRows] = useState(ROWS);
  const [shown, setShown] = useState(0);
  const [focus, setFocus] = useState<{ sessionId: string; at: number } | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // What `Chat` does with a pick: the lit block at the top of the pane.
  useEffect(() => {
    if (!focus) return;
    const frame = requestAnimationFrame(() => {
      const pane = scroller.current;
      const node = pane?.querySelector<HTMLElement>("[data-bot-focus]");
      if (!pane || !node) return;
      const top = node.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
      pane.scrollTo({ top: Math.max(top - 12, 0), behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  useEffect(() => {
    const pane = scroller.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [shown]);
  const readySince = useRef(new Map<string, number>());
  const prs = new Map(rows.map((r) => [r.row.item.sessionId, r.pr]));
  const stalls = stalledTasks(rows.map((r) => r.row), (r) => prs.get(r.item.sessionId), readySince.current, NOW, () => true);
  const card = stalls.filter(onCard);
  const nudges = stalls.filter((s) => !needLine(s));

  const writeNeeds = () =>
    setRows((all) =>
      all.map((r) =>
        r.answered
          ? { ...r, row: { ...r.row, busy: true } }
          : r.need
            ? { ...r, row: { ...r.row, item: { ...r.row.item, need: { text: r.need, at: new Date().toISOString() } } } }
            : r,
      ),
    );

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4 p-10">
        <h1 className="text-lg font-medium">Stalled tasks in a bot's chat</h1>
        <p className="max-w-xl text-ui text-muted-foreground">
          Eleven tasks, eight stalled. A ready PR and a task idle on you reach the card; every stall goes to the bot. A row
          scrolls the chat to the bot's reply about the task; Open task, on hover, opens it. Merge waits a
          second and takes the row away, as settling does.
        </p>
        <div className="flex items-center gap-4 text-ui">
          <button type="button" className="underline" onClick={writeNeeds}>
            Bot writes needs
          </button>
          <button
            type="button"
            className="underline"
            onClick={() => {
              localStorage.removeItem("ade.dismissedStalls");
              setRows(ROWS);
              setShown((n) => n + 1);
            }}
          >
            Reset
          </button>
        </div>
        {/* The chat column's width and gap, scrolling as the pane does. */}
        <div ref={scroller} className="h-[560px] max-w-3xl overflow-y-auto rounded-xl border border-border">
          <div className="flex flex-col gap-4 px-6 py-6" data-bot-chat>
            <BotTranscript
              unread={false}
              segments={[{ sessionId: BOT, harness: "claude_code", created: EVENTS[0].ts, events: EVENTS }]}
              busy={false}
              taskOf={(id) => {
                const r = ROWS.find((x) => x.row.item.sessionId === id);
                return r && { sessionId: id, title: r.row.item.title };
              }}
              onOpenSession={() => {}}
              focus={focus}
            />
            <StalledTasks
              key={shown}
              stalls={card}
              now={NOW}
              onFocus={(sessionId) => setFocus({ sessionId, at: Date.now() })}
              onOpen={(id) => setOpened(ROWS.find((x) => x.row.item.sessionId === id)?.row.item.title ?? id)}
            onMerge={async (r) => {
              await new Promise((done) => setTimeout(done, 1000));
              setRows((all) => all.filter((x) => x.row.item.sessionId !== r.item.sessionId));
            }}
            />
          </div>
        </div>
        {opened && <span className="text-ui text-muted-foreground">Open → would open “{opened}”</span>}
        <div className="flex max-w-3xl flex-col gap-1 text-ui">
          <span className="text-muted-foreground">Nudges sent to the bot, hidden from the reader</span>
          {nudges.map((s) => (
            <span key={s.key} className="font-mono text-[12px] text-foreground/80">
              {s.row.item.title}: Stall nudge:{" "}
              {s.kind === "ready"
                ? `this task's PR #${s.pr?.number} is ready to merge and has sat for ${compactAge(s.row.item.modified, NOW)}. Its last message: …`
                : `this task has sat ${s.kind === "fix" ? "untouched" : "idle"} for ${compactAge(s.row.item.modified, NOW)}. ${s.problem ?? "Waiting on the user. Its last message: …"}`}
            </span>
          ))}
        </div>
      </div>
      <DemoThemeBar />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
