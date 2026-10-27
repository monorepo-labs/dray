"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileCode2 } from "lucide-react";

import { BrowserChrome } from "@/components/app/Browser";
import Orb from "@/components/app/Orb";
import Panel, {
  CheckPassed,
  CheckRow,
  CheckRunning,
  CommentRow,
  PrMergedGlyph,
  PrOpenGlyph,
  PrRow,
  Readiness,
  Section,
  VercelMark,
} from "@/components/app/Panel";
import Sidebar, { GroupBreak, SessionRow, TaskHint } from "@/components/app/Sidebar";
import { AddTab, BranchButton, ChatIcon, ItemTab, PanelToggle } from "@/components/app/Tabs";
import { GitHubGlyph } from "@/components/GitHubGlyph";
import {
  AssistantText,
  CheckpointRail,
  Composer,
  NewTaskComposer,
  QuestionCard,
  ToolGroup,
  Transcript,
  Turn,
  UserBubble,
} from "@/components/app/Chat";
import Window from "@/components/app/Window";
import { ClaudeGlyph } from "@/components/ClaudeGlyph";
import { GreptileGlyph } from "@/components/GreptileGlyph";
import { ScaledWindow } from "./ScaledWindow";
import s from "./Hero.module.css";

const WIDTH = 1128;
const HEIGHT = 720;

/// The four sessions that were there before the visitor arrived. The rest of
/// the list is scenery.
type Fixed = "linear" | "speedrun" | "comments" | "background";

/// One the visitor started from the new task page. No agent reads the
/// prompt, so it answers with one of `GENERIC` once `done`.
type Started = {
  id: string;
  prompt: string;
  branch: string;
  reply: number;
  done: boolean;
  /// Finished while the visitor was looking elsewhere.
  unread: boolean;
};

const TITLES: Record<Fixed, string> = {
  linear: "Linear agent tags issues",
  speedrun: "Add app speedrun",
  comments: "Fix PR panel comments",
  background: "Stop background tasks",
};

const BRANCHES: Record<Fixed, string> = {
  linear: "amber-quiet-delta",
  speedrun: "north-tidal-spruce",
  comments: "pale-iron-harbor",
  background: "fleet-crimson-fjord",
};

const NEW_BRANCHES = ["calm-owl-ridge", "brisk-jade-cove", "quiet-lime-fen", "bold-sage-reef"];

/// What a started session says when it finishes. Written so it fits any
/// prompt, since none of them is read.
const GENERIC = [
  { tools: "9 tool calls · 2 files changed", text: "Done. I kept the change small, ran the tests, and they pass. Want me to open a PR?" },
  { tools: "14 tool calls · 4 files changed", text: "That's in. Typecheck and tests are green, and nothing outside the files it needed was touched." },
  { tools: "6 tool calls · 1 file changed", text: "Finished. One call is yours: the simplest version changes a default, so I left the default as it was and noted where to flip it." },
  { tools: "11 tool calls · 3 files changed", text: "All set. I tried it in the browser and it behaves the way you described. Say the word and I'll push it." },
];

const CONTEXT: Record<string, number> = { linear: 0.18, speedrun: 0.52, comments: 0.4, background: 0.31 };

const QUESTION = {
  question: "Six issues fit two areas. Which label should they get?",
  options: [
    { label: "The narrower area", description: "Composer over chat, browser over panels." },
    { label: "Both areas", description: "Each of the six carries two labels." },
    { label: "Leave them to me", description: "Tag the other 36 and list these six." },
  ],
};

/// What the agent says once it has the answer. A skip leaves it to the agent.
const REPLIES: Record<string, string> = {
  "The narrower area": "Tagged all 42. The six that fit two areas went to the narrower one: four composer, two browser.",
  "Both areas": "Tagged all 42. The six that fit two areas carry both labels.",
  "Leave them to me": "Tagged 36. The six left are DRA-112, 118, 131, 140, 152 and 167.",
  skipped: "No preference, so I went narrow. Tagged all 42; the six that fit two areas took the more specific one.",
};

type MergeState = "open" | "confirming" | "merging" | "merged";

/// The app, whole, above the fold, and the visitor can touch it. It opens on
/// a session beside its pull request with the last check still running; the
/// check passes on its own and from then on nothing moves unless the visitor
/// does — open another session, answer the one waiting on a question, start a
/// task, flip the panel's tabs, open the dev server's tab, merge the PR.
/// `startX` is where a phone's sideways scroll opens; 0 opens on the sidebar.
export function Hero({ className, startX = 240 }: { className?: string; startX?: number }) {
  const [selected, setSelected] = useState<string>("background");
  const [view, setView] = useState<"chat" | "browser">("chat");
  const [panelTab, setPanelTab] = useState("PR");
  const [speedrunRead, setSpeedrunRead] = useState(false);
  const [checksPassed, setChecksPassed] = useState(false);
  const [merge, setMerge] = useState<MergeState>("open");
  // `undefined` is unanswered; `null` is Skip, which is an answer too.
  const [answer, setAnswer] = useState<string | null | undefined>(undefined);
  const [tagged, setTagged] = useState(false);
  const [started, setStarted] = useState<Started[]>([]);
  const [draft, setDraft] = useState("");
  // Read when a started session finishes, which is after the render that
  // started it: a state value captured then would be the session it opened on.
  const selectedRef = useRef(selected);

  useEffect(() => {
    const t = setTimeout(() => setChecksPassed(true), 3000);
    return () => clearTimeout(t);
  }, []);

  const open = (id: string) => {
    selectedRef.current = id;
    setSelected(id);
    setStarted((list) => list.map((t) => (t.id === id ? { ...t, unread: false } : t)));
    setView("chat");
    if (id === "speedrun") setSpeedrunRead(true);
  };

  const answerQuestion = (label: string | null) => {
    setAnswer(label);
    setTimeout(() => setTagged(true), 700);
  };

  const confirmMerge = () => {
    setMerge("merging");
    setTimeout(() => setMerge("merged"), 900);
  };

  const send = () => {
    const prompt = draft.trim();
    if (!prompt) return;
    const id = `task-${Date.now()}`;
    // Newest three kept, so the list never runs past the sidebar's
    // foot and takes the scripted sessions with it; scroll it if more matter.
    const task = {
      id,
      prompt,
      branch: NEW_BRANCHES[started.length % NEW_BRANCHES.length],
      reply: Math.floor(Math.random() * GENERIC.length),
      done: false,
      unread: false,
    };
    setStarted((list) => [task, ...list].slice(0, 3));
    setDraft("");
    open(id);
    setTimeout(
      () =>
        setStarted((list) =>
          list.map((t) => (t.id === id ? { ...t, done: true, unread: selectedRef.current !== id } : t)),
        ),
      600 + Math.random() * 500,
    );
  };

  const merged = merge === "merged";
  const pr = merged ? <PrMergedGlyph /> : <PrOpenGlyph />;
  const hasPr = selected === "background";
  const isNew = selected === "new";
  const task = started.find((t) => t.id === selected);
  const title = task?.prompt ?? TITLES[selected as Fixed];
  const linearWorking = answer !== undefined && !tagged;

  return (
    <ScaledWindow width={WIDTH} height={HEIGHT} minScale={0.7} startX={startX} className={`${s.scene} ${className ?? ""}`}>
      <Window
        interactive
        className="h-full w-full"
        sidebar={
          // The live list runs by stage, workspace-wide, with no headings:
          // what wants the reader first, then what is idle, then pull
          // requests by how far along they are, then what was set aside.
          <Sidebar onNewTask={() => open("new")}>
            <SessionRow
              title={TITLES.linear}
              unread={answer === undefined ? "command" : undefined}
              trailing={linearWorking ? <Orb /> : answer !== undefined ? "now" : "2m"}
              active={selected === "linear"}
              onClick={() => open("linear")}
            />
            <SessionRow
              title={TITLES.speedrun}
              unread={speedrunRead ? undefined : "add"}
              trailing="5m"
              active={selected === "speedrun"}
              onClick={() => open("speedrun")}
            />
            <GroupBreak />
            {started.map((t) => (
              <SessionRow
                key={t.id}
                title={t.prompt}
                unread={t.unread ? "add" : undefined}
                trailing={t.done ? "now" : <Orb />}
                active={selected === t.id}
                onClick={() => open(t.id)}
              />
            ))}
            <SessionRow
              title={TITLES.comments}
              trailing={<Orb />}
              active={selected === "comments"}
              onClick={() => open("comments")}
            />
            <SessionRow title="Test run and greeting" trailing="1d" />
            <GroupBreak />
            <SessionRow
              title={TITLES.background}
              pr={pr}
              trailing={merged ? "now" : "6m"}
              active={selected === "background"}
              onClick={() => open("background")}
            />
            <SessionRow title="Settings theme picker" pr={<PrOpenGlyph />} trailing="18h" />
            <GroupBreak />
            <SessionRow title="Draw placed tags as chips" pr={<PrMergedGlyph />} trailing="2d" />
            <SessionRow title="Clamp long user bubbles" pr={<PrMergedGlyph />} trailing="3d" />
            <GroupBreak />
            {/* Set aside: started, not wanted now, so held back at the foot. */}
            <SessionRow title="Outline view from tree-sitter" trailing="1w" className="opacity-30" />
            <SessionRow title="Port drafts to SQLite" trailing="2w" className="opacity-30" />
            <TaskHint />
          </Sidebar>
        }
        tabs={
          isNew ? (
            <span className="px-2 text-ui text-muted-foreground">New session</span>
          ) : hasPr ? (
            <>
              <ItemTab
                icon={<ChatIcon />}
                label={`ade / ${TITLES.background}`}
                active={view === "chat"}
                onClick={() => setView("chat")}
              />
              {/* The browser's pages are tabs of the same row. The one the
                  agent is driving wears the orb where its favicon would be. */}
              <ItemTab
                icon={
                  <span className="-m-0.5 flex shrink-0">
                    <Orb state="searching" size={18} />
                  </span>
                }
                label="localhost:3000"
                active={view === "browser"}
                onClick={() => setView("browser")}
              />
              <ItemTab icon={<VercelMark className="size-3.5" />} label="dray – Deployments – Vercel" />
              <ItemTab
                icon={<GitHubGlyph className="size-3.5 shrink-0" />}
                label="Stop background tasks · Pull Request #44"
              />
              <AddTab />
            </>
          ) : (
            // A lone chat is a title rather than a tab.
            <ItemTab icon={<ChatIcon />} label={`ade / ${title}`} plain />
          )
        }
        headerEnd={
          <>
            {!isNew && <BranchButton name={task?.branch ?? BRANCHES[selected as Fixed]} />}
            {/* The pull request stands in for the panel toggle, lit while the
                pane is open on it. */}
            {hasPr ? <ItemTab icon={pr} label="#44" active fixed /> : <PanelToggle />}
          </>
        }
        main={
          isNew ? (
            <NewTaskComposer
              value={draft}
              onChange={setDraft}
              onSend={send}
              agent={<ClaudeGlyph className="size-3.5" />}
              model="Opus 5.5"
              effort="High"
              mode="Auto"
              project="ade"
              base="main"
            />
          ) : view === "browser" && hasPr ? (
            <DevServerPage />
          ) : (
            <>
              <Transcript>
                {selected === "background" && (
                  <CheckpointRail count={3} activeIndex={2} className="absolute top-1/2 left-0.5 -translate-y-1/2" />
                )}
                {selected === "linear" && (
                  <LinearSession answer={answer} tagged={tagged} onAnswer={answerQuestion} />
                )}
                {selected === "speedrun" && <SpeedrunSession />}
                {selected === "comments" && <CommentsSession />}
                {selected === "background" && <BackgroundSession />}
                {task && (
                  <Turn>
                    <UserBubble>{task.prompt}</UserBubble>
                    {task.done ? (
                      <>
                        <Enter>
                          <ToolGroup label={GENERIC[task.reply].tools} />
                        </Enter>
                        <Streamed id={task.id} text={GENERIC[task.reply].text} />
                      </>
                    ) : (
                      <Working />
                    )}
                  </Turn>
                )}
              </Transcript>
              <Composer
                placeholder="Follow-up. @files. /skills. &tasks. #issues."
                mic
                agent={<ClaudeGlyph className="size-3.5" />}
                model="Opus 5.5"
                effort="High"
                mode="Auto"
                context={CONTEXT[selected] ?? 0.04}
              />
            </>
          )
        }
        panel={
          hasPr && (
            <Panel tabs={["PR", "Changes", "Browser", "More"]} active={panelTab} onSelect={setPanelTab} width={410}>
              {panelTab === "PR" && (
                <PrBody
                  checksPassed={checksPassed}
                  merge={merge}
                  glyph={pr}
                  onMerge={() => setMerge("confirming")}
                  onCancel={() => setMerge("open")}
                  onConfirm={confirmMerge}
                />
              )}
              {panelTab === "Changes" && <ChangesBody />}
              {panelTab === "Browser" && <DevServerPage tab="Dray — Every coding agent, one window" />}
              {panelTab === "More" && <MoreBody />}
            </Panel>
          )
        }
      />
    </ScaledWindow>
  );
}

/// What appears after the visitor acts, eased in; reduced motion draws it
/// in place.
function Enter({ children }: { children: ReactNode }) {
  return <div className={s.enter}>{children}</div>;
}

/// Replies already streamed once, so coming back to a session shows the
/// reply whole rather than typing it out again.
const streamed = new Set<string>();

/// A reply arriving the way the app's does: a few characters a frame, about
/// 200 a second. Reduced motion draws it whole.
function Streamed({ id, text }: { id: string; text: string }) {
  const [shown, setShown] = useState(() => (streamed.has(id) ? text.length : 0));

  useEffect(() => {
    if (streamed.has(id) || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      streamed.add(id);
      setShown(text.length);
      return;
    }
    const t = setInterval(() => {
      setShown((n) => {
        if (n + 3 >= text.length) {
          clearInterval(t);
          streamed.add(id);
          return text.length;
        }
        return n + 3;
      });
    }, 16);
    return () => clearInterval(t);
  }, [id, text]);

  return <AssistantText>{text.slice(0, shown)}</AssistantText>;
}

/// The agent mid-turn, as the transcript draws it under the last row.
function Working() {
  return (
    <div className="flex h-6 items-center">
      <Orb />
    </div>
  );
}

function LinearSession({
  answer,
  tagged,
  onAnswer,
}: {
  answer: string | null | undefined;
  tagged: boolean;
  onAnswer: (label: string | null) => void;
}) {
  const answered = answer !== undefined;
  return (
    <Turn>
      <UserBubble>tag every open issue with its area label</UserBubble>
      <ToolGroup label="5 tool calls" />
      <AssistantText>
        42 open issues matched an area. Six of them fit two, so one question before I write
        anything to Linear.
      </AssistantText>
      {/* The agent is blocked until this is answered; once it is, the card
          settles into a row and the work carries on. */}
      {answered ? (
        <Enter>
          <ToolGroup label={`Asked a question · ${answer ?? "Skipped"}`} />
        </Enter>
      ) : (
        <QuestionCard question={QUESTION.question} options={QUESTION.options} onAnswer={onAnswer} />
      )}
      {answered && (
        <Enter>
          <ToolGroup label="1 tool call" />
        </Enter>
      )}
      {answered &&
        (tagged ? (
          <Streamed id="linear" text={REPLIES[answer ?? "skipped"]} />
        ) : (
          <Working />
        ))}
    </Turn>
  );
}

function SpeedrunSession() {
  return (
    <Turn>
      <UserBubble>add a speedrun timer: first prompt to first merged PR</UserBubble>
      <ToolGroup label="14 tool calls · 3 files changed" />
      <AssistantText>
        Done. The timer starts on a session&apos;s first prompt and stops when its pull request
        merges; the time sits beside the title in the sidebar. It&apos;s under Settings → Labs,
        off by default.
      </AssistantText>
    </Turn>
  );
}

function CommentsSession() {
  return (
    <Turn>
      <UserBubble>comments with a reply thread show up twice in the PR panel</UserBubble>
      <ToolGroup label="6 tool calls" />
      <AssistantText>
        Both the review and its thread were drawn. A review with no body is only worth keeping
        when it names who left the thread, so that is the one case it stays. Fixing the join now.
      </AssistantText>
      <ToolGroup label="2 tool calls" />
      <Working />
    </Turn>
  );
}

function BackgroundSession() {
  return (
    <Turn>
      <AssistantText>
        The turn stayed open because two background tasks never reported. Both are stopped on{" "}
        <code className="rounded bg-muted px-1 font-mono text-code">result</code> now, and the panel
        reads them off the live set instead.
      </AssistantText>
      <UserBubble>push it and open a PR</UserBubble>
      <ToolGroup label="4 tool calls · 1 message" />
      <AssistantText>
        Pushed to PR #44. Greptile is still reviewing; Vercel is green. The merge is yours once the
        checks land.
      </AssistantText>
    </Turn>
  );
}

const PANEL_BUTTON =
  "flex h-7 items-center rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

function PrBody({
  checksPassed,
  merge,
  glyph,
  onMerge,
  onCancel,
  onConfirm,
}: {
  checksPassed: boolean;
  merge: MergeState;
  glyph: ReactNode;
  onMerge: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <PrRow number={44} title="Stop background tasks holding the turn open" added={275} removed={70} glyph={glyph} />
      <div className="flex flex-col gap-4 pb-3">
        {/* A merged PR has nothing left to decide, so the verdict and its
            button go with it. */}
        {merge !== "merged" && (
          <Readiness
            tone={checksPassed ? "ready" : "pending"}
            ready={checksPassed}
            base="main"
            label={checksPassed ? "Ready to merge" : "Checks not passing"}
            detail={checksPassed ? undefined : "Merging is allowed, but something is red."}
            onMerge={onMerge}
            action={
              // The least reversible control on the pane asks once: the press
              // turns the split button into Cancel and a confirm naming the
              // method.
              merge === "confirming" ? (
                <>
                  <button type="button" onClick={onCancel} className={`${PANEL_BUTTON} hover:bg-muted/70`}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={onConfirm}
                    className={`${PANEL_BUTTON} bg-accent-merge text-accent-merge-foreground shadow-[0_1px_4px_rgba(0,0,0,0.35)] hover:bg-accent-merge-hover`}
                  >
                    Confirm squash and merge
                  </button>
                </>
              ) : merge === "merging" ? (
                <span className={`${PANEL_BUTTON} bg-accent-merge text-accent-merge-foreground opacity-60`}>
                  Merging…
                </span>
              ) : undefined
            }
          />
        )}
        <Section title="Checks" count={checksPassed ? "3 passed" : "1 running · 2 passed"}>
          <CheckRow
            name="Greptile Review"
            avatar={<GreptileGlyph className="size-2.5" />}
            state={checksPassed ? <CheckPassed /> : <CheckRunning />}
          />
          <CheckRow name="Vercel" avatar={<VercelMark />} state={<CheckPassed />} />
          <CheckRow name="Vercel Preview Comments" avatar={<VercelMark />} state={<CheckPassed />} />
        </Section>
        <Section title="Comments" count={3}>
          <div className="flex flex-col gap-2">
            <CommentRow
              avatar={<VercelMark />}
              author="vercel"
              preview="The latest updates on your projects. Learn more about Vercel for GitHub."
              age="46m"
            />
            <CommentRow avatar={<GreptileGlyph className="size-2.5" />} author="greptile-apps" preview="Greptile Summary" age="42m" />
            <CommentRow
              avatar={<GreptileGlyph className="size-2.5" />}
              author="greptile-apps"
              word="reviewed"
              replies={2}
              age="42m"
            />
          </div>
        </Section>
      </div>
    </>
  );
}

/// What the last turn touched, the PR's own +275 −70 split across its files.
/// The directory is muted ahead of the name, so it is what a narrow pane cuts.
const CHANGED = [
  { dir: "src-tauri/src/", name: "session.rs", added: 142, removed: 38 },
  { dir: "src/components/", name: "SubagentPanel.tsx", added: 61, removed: 12 },
  { dir: "src/lib/", name: "transcript.ts", added: 48, removed: 17 },
  { dir: "src-tauri/src/harness/claude_code/", name: "mapper.rs", added: 24, removed: 3 },
];

function ChangesBody() {
  return (
    <div className="flex flex-col">
      {CHANGED.map((file) => (
        <div key={file.name} className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-ui">
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted-foreground">{file.dir}</span>
            <span className="text-sidebar-foreground">{file.name}</span>
          </span>
          <span className="shrink-0 font-mono">
            <span className="text-accent-add">+{file.added}</span>{" "}
            <span className="text-destructive">−{file.removed}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

const TODOS = [
  "Find why the turn stays open",
  "Stop background tasks on result",
  "Read the panel's tasks off the live set",
  "Open a PR",
];

/// The More tab: the session's task list, then what is still running behind
/// it. Each section carries its own heading, or neither would.
function MoreBody() {
  return (
    <div className="flex flex-col">
      <div className="px-3 pt-3 pb-2 text-ui text-muted-foreground">Tasks</div>
      <ul className="flex flex-col gap-1.5 px-3 pb-3">
        {TODOS.map((todo) => (
          <li key={todo} className="flex items-start gap-2 text-chat leading-snug text-muted-foreground">
            <svg viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0" aria-hidden>
              <rect width="16" height="16" rx="6" className="fill-accent-add" />
              <path
                d="m4.6 8.3 2.2 2.2 4.6-4.8"
                fill="none"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="stroke-background"
              />
            </svg>
            {todo}
          </li>
        ))}
      </ul>
      <div className="px-3 pt-4 pb-2 text-ui text-muted-foreground">Background Tasks</div>
      <div className="flex items-center gap-2 px-3 py-1.5 text-ui">
        <Orb size={16} />
        <span className="min-w-0 flex-1 truncate text-sidebar-foreground">Start the dev server</span>
        <span className="shrink-0 font-mono text-muted-foreground">pnpm dev</span>
      </div>
    </div>
  );
}

/// localhost:3000, the page the agent is driving, which is this site. In the
/// main column's Browser view its tabs live in the titlebar, so it draws a
/// toolbar alone; in the panel it brings its own strip.
function DevServerPage({ tab }: { tab?: string }) {
  return (
    <BrowserChrome tab={tab} url="localhost:3000" className="flex-1">
      <div className="absolute inset-0 flex flex-col px-8 pt-6">
        <div className="flex items-center gap-5 text-ui text-muted-foreground">
          <span className="font-display text-base font-medium text-foreground">Dray</span>
          <span>Features</span>
          <span>Changelog</span>
          <span>GitHub</span>
        </div>
        <h1 className="mt-14 font-display text-[2rem] leading-[1.1] font-medium tracking-tight text-foreground">
          Every coding agent, one window.
        </h1>
        <p className="mt-3 max-w-md text-chat text-muted-foreground">
          Claude Code, Codex, pi and fx — on your existing subscriptions.
        </p>
        <span className="mt-6 inline-flex h-9 items-center self-start rounded-full bg-primary px-5 text-ui font-medium text-primary-foreground">
          Download for Mac
        </span>
      </div>
    </BrowserChrome>
  );
}
