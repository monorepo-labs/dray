"use client";

import { useEffect, useState, type ReactNode } from "react";

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
  PermissionCard,
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

/// The four rows a visitor can open. The rest of the list is scenery.
type Id = "linear" | "speedrun" | "comments" | "background";

const TITLES: Record<Id, string> = {
  linear: "Linear agent tags issues",
  speedrun: "Add app speedrun",
  comments: "Fix PR panel comments",
  background: "Stop background tasks",
};

const BRANCHES: Record<Id, string> = {
  linear: "amber-quiet-delta",
  speedrun: "north-tidal-spruce",
  comments: "pale-iron-harbor",
  background: "fleet-crimson-fjord",
};

/// The app, whole, above the fold, and the visitor can touch it. It opens on
/// a session beside its pull request with the last check still running; the
/// check passes on its own and from then on nothing moves unless the visitor
/// does — open another session, answer the one waiting on a question, open
/// the dev server's tab, merge the PR. `startX` is where a phone's sideways
/// scroll opens; 0 opens on the sidebar.
export function Hero({ className, startX = 240 }: { className?: string; startX?: number }) {
  const [selected, setSelected] = useState<Id>("background");
  const [view, setView] = useState<"chat" | "browser">("chat");
  const [speedrunRead, setSpeedrunRead] = useState(false);
  const [checksPassed, setChecksPassed] = useState(false);
  const [merged, setMerged] = useState(false);
  const [answer, setAnswer] = useState<"allow" | "deny" | null>(null);
  const [tagged, setTagged] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setChecksPassed(true), 3000);
    return () => clearTimeout(t);
  }, []);

  const open = (id: Id) => {
    setSelected(id);
    setView("chat");
    if (id === "speedrun") setSpeedrunRead(true);
  };

  const allow = () => {
    setAnswer("allow");
    setTimeout(() => setTagged(true), 1800);
  };

  const pr = merged ? <PrMergedGlyph /> : <PrOpenGlyph />;
  const hasPr = selected === "background";
  const linearWorking = answer === "allow" && !tagged;

  return (
    <ScaledWindow width={WIDTH} height={HEIGHT} minScale={0.7} startX={startX} className={`${s.scene} ${className ?? ""}`}>
      <Window
        interactive
        className="h-full w-full"
        sidebar={
          // The live list runs by stage, workspace-wide, with no headings:
          // what wants the reader first, then what is idle, then pull
          // requests by how far along they are.
          <Sidebar>
            <SessionRow
              title={TITLES.linear}
              unread={answer ? undefined : "command"}
              trailing={linearWorking ? <Orb /> : answer ? "now" : "2m"}
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
            <TaskHint />
          </Sidebar>
        }
        tabs={
          hasPr ? (
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
            <ItemTab icon={<ChatIcon />} label={`ade / ${TITLES[selected]}`} plain />
          )
        }
        headerEnd={
          <>
            <BranchButton name={BRANCHES[selected]} />
            {/* The pull request stands in for the panel toggle, lit while the
                pane is open on it. */}
            {hasPr ? <ItemTab icon={pr} label="#44" active fixed /> : <PanelToggle />}
          </>
        }
        main={
          view === "browser" ? (
            <DevServerPage />
          ) : (
            <>
              <Transcript>
                {selected === "background" && (
                  <CheckpointRail count={3} activeIndex={2} className="absolute top-1/2 left-0.5 -translate-y-1/2" />
                )}
                {selected === "linear" && (
                  <LinearSession
                    answer={answer}
                    tagged={tagged}
                    onAllow={allow}
                    onDeny={() => setAnswer("deny")}
                  />
                )}
                {selected === "speedrun" && <SpeedrunSession />}
                {selected === "comments" && <CommentsSession />}
                {selected === "background" && <BackgroundSession />}
              </Transcript>
              <Composer
                placeholder="Follow-up. @files. /skills. &tasks. #issues."
                mic
                agent={<ClaudeGlyph className="size-3.5" />}
                model="Opus 5.5"
                effort="High"
                mode="Auto"
                context={CONTEXT[selected]}
              />
            </>
          )
        }
        panel={
          hasPr && (
            <PrPanel checksPassed={checksPassed} merged={merged} glyph={pr} onMerge={() => setMerged(true)} />
          )
        }
      />
    </ScaledWindow>
  );
}

const CONTEXT: Record<Id, number> = { linear: 0.18, speedrun: 0.52, comments: 0.4, background: 0.31 };

/// What appears after the visitor acts, eased in; reduced motion draws it
/// in place.
function Enter({ children }: { children: ReactNode }) {
  return <div className={s.enter}>{children}</div>;
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
  onAllow,
  onDeny,
}: {
  answer: "allow" | "deny" | null;
  tagged: boolean;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <>
      <Turn>
        <UserBubble>tag every open issue with its area label</UserBubble>
        <ToolGroup label="5 tool calls" />
        <AssistantText>
          The dry run matched 42 open issues to an area. Applying the labels writes to Linear,
          so that step waits on you.
        </AssistantText>
        {answer === "allow" && (
          <Enter>
            <ToolGroup label="1 tool call" />
          </Enter>
        )}
        {answer === "allow" &&
          (tagged ? (
            <Enter>
              <AssistantText>
                Tagged all 42: 17 chat, 11 sidebar, 9 composer, 5 browser. None were left
                without an area.
              </AssistantText>
            </Enter>
          ) : (
            <Working />
          ))}
        {answer === "deny" && (
          <Enter>
            <AssistantText>
              Left them untouched. The dry run&apos;s matches are above if you&apos;d rather
              label some by hand.
            </AssistantText>
          </Enter>
        )}
      </Turn>
      {/* Below the turn, where the app draws it: the agent is blocked until
          it is answered. */}
      {!answer && (
        <PermissionCard
          argument="pnpm tsx scripts/tag-issues.ts --apply"
          description="Apply area labels to 42 Linear issues"
          rule="pnpm tsx"
          onAllow={onAllow}
          onDeny={onDeny}
        />
      )}
    </>
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

function PrPanel({
  checksPassed,
  merged,
  glyph,
  onMerge,
}: {
  checksPassed: boolean;
  merged: boolean;
  glyph: ReactNode;
  onMerge: () => void;
}) {
  return (
    <Panel tabs={["PR", "Changes", "Browser", "More"]} active="PR" width={410}>
      <PrRow number={44} title="Stop background tasks holding the turn open" added={275} removed={70} glyph={glyph} />
      <div className="flex flex-col gap-4 pb-3">
        {/* A merged PR has nothing left to decide, so the verdict and its
            button go with it. */}
        {!merged && (
          <Readiness
            tone={checksPassed ? "ready" : "pending"}
            ready={checksPassed}
            base="main"
            label={checksPassed ? "Ready to merge" : "Checks not passing"}
            detail={checksPassed ? undefined : "Merging is allowed, but something is red."}
            onMerge={onMerge}
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
    </Panel>
  );
}

/// localhost:3000 in the main column's Browser view: the page the agent is
/// driving, which is this site. The tabs live in the titlebar, so the pane
/// draws its toolbar and no strip.
function DevServerPage() {
  return (
    <BrowserChrome url="localhost:3000" className="flex-1">
      <div className="absolute inset-0 flex flex-col px-10 pt-6">
        <div className="flex items-center gap-5 text-ui text-muted-foreground">
          <span className="font-display text-base font-medium text-foreground">Dray</span>
          <span>Features</span>
          <span>Changelog</span>
          <span>GitHub</span>
        </div>
        <h1 className="mt-16 font-display text-[2.2rem] leading-[1.1] font-medium tracking-tight text-foreground">
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
