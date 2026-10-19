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
import { AddTab, BranchButton, ChatIcon, ItemTab } from "@/components/app/Tabs";
import { GitHubGlyph } from "@/components/GitHubGlyph";
import {
  AssistantText,
  CheckpointRail,
  Composer,
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

/// The app, whole, above the fold: a session beside its pull request. The
/// last check passes, the reader says merge it, the agent does, and the panel
/// follows — the one loop that shows where a Dray session ends up.
export function Hero({ className }: { className?: string }) {
  return (
    <ScaledWindow width={WIDTH} height={HEIGHT} minScale={0.7} startX={240} className={`${s.scene} ${className ?? ""}`}>
      <Window
        className="h-full w-full"
        sidebar={
          // The live list runs by stage, workspace-wide, with no headings:
          // what wants the reader first, then what is idle, then pull
          // requests by how far along they are.
          <Sidebar>
            <SessionRow title="Linear agent tags issues" unread="command" trailing="2m" />
            <SessionRow title="Add app speedrun" unread="add" trailing="5m" />
            <GroupBreak />
            <SessionRow title="Fix PR panel comments" trailing={<Orb />} />
            <SessionRow title="Test run and greeting" trailing="1d" />
            <GroupBreak />
            <SessionRow title="Stop background tasks" active pr={<PrFace />} trailing="6m" />
            <SessionRow title="Settings theme picker" pr={<PrOpenGlyph />} trailing="18h" />
            <GroupBreak />
            <SessionRow title="Draw placed tags as chips" pr={<PrMergedGlyph />} trailing="2d" />
            <SessionRow title="Clamp long user bubbles" pr={<PrMergedGlyph />} trailing="3d" />
            <TaskHint />
          </Sidebar>
        }
        tabs={
          <>
            <ItemTab icon={<ChatIcon />} label="ade / Stop background tasks" active />
            {/* The browser's pages are tabs of the same row. The one the agent
                is driving wears the orb where its favicon would be. */}
            <ItemTab
              icon={
                <span className="-m-0.5 flex shrink-0">
                  <Orb state="searching" size={18} />
                </span>
              }
              label="localhost:3000"
            />
            <ItemTab icon={<VercelMark className="size-3.5" />} label="dray – Deployments – Vercel" />
            <ItemTab
              icon={<GitHubGlyph className="size-3.5 shrink-0" />}
              label="Stop background tasks · Pull Request #44"
            />
            <AddTab />
          </>
        }
        headerEnd={
          <>
            <BranchButton name="fleet-crimson-fjord" />
            {/* The pull request stands in for the panel toggle, lit while the
                pane is open on it. */}
            <ItemTab icon={<PrFace />} label="#44" active fixed />
          </>
        }
        main={
          <>
            <Transcript>
              <CheckpointRail count={3} activeIndex={2} className="absolute top-1/2 left-0.5 -translate-y-1/2" />
              <Turn>
                <AssistantText>
                  The turn stayed open because two background tasks never reported. Both
                  are stopped on <code className="rounded bg-muted px-1 font-mono text-code">result</code> now,
                  and the panel reads them off the live set instead.
                </AssistantText>
                <UserBubble>push it and open a PR</UserBubble>
                <ToolGroup label="4 tool calls · 1 message" />
                <AssistantText>
                  Pushed to PR #44. Greptile is still reviewing; Vercel is green. I&apos;ll
                  leave it to you once the checks land.
                </AssistantText>
                <UserBubble className={s.bubble}>merge it once it&apos;s green</UserBubble>
                <ToolGroup className={s.call} label="1 tool call" />
                <AssistantText className={s.said}>
                  Merged #44 into main. The worktree is clean; nothing else needed here.
                </AssistantText>
              </Turn>
            </Transcript>
            <Composer
              placeholder="Follow-up. @files. /skills. &tasks. #issues."
              mic
              agent={<ClaudeGlyph className="size-3.5" />}
              model="Opus 5.5"
              effort="High"
              mode="Auto"
              context={0.31}
            />
          </>
        }
        panel={
          <Panel tabs={["PR", "Changes", "Browser", "More"]} active="PR" width={410}>
            <PrRow
              number={44}
              title="Stop background tasks holding the turn open"
              added={275}
              removed={70}
              glyph={<PrFace />}
            />
            <div className="flex flex-col gap-4 pb-3">
              <Readiness
                className={s.readiness}
                tone="ready"
                ready
                base="main"
                label={
                  <span className="grid">
                    <span className={`col-start-1 row-start-1 text-accent-command ${s.notReady}`}>
                      Checks not passing
                    </span>
                    <span className={`col-start-1 row-start-1 ${s.ready}`}>Ready to merge</span>
                  </span>
                }
                detail={
                  <span className="grid">
                    <span className={`col-start-1 row-start-1 ${s.notReady}`}>
                      Merging is allowed, but something is red.
                    </span>
                  </span>
                }
              />
              <Section
                title="Checks"
                count={
                  <span className="grid">
                    <span className={`col-start-1 row-start-1 ${s.running}`}>1 running · 2 passed</span>
                    <span className={`col-start-1 row-start-1 ${s.passed}`}>3 passed</span>
                  </span>
                }
              >
                <CheckRow
                  name="Greptile Review"
                  avatar={<GreptileGlyph className="size-2.5" />}
                  state={
                    <span className="grid size-3.5 shrink-0">
                      <CheckRunning className={`col-start-1 row-start-1 ${s.running}`} />
                      <CheckPassed className={`col-start-1 row-start-1 ${s.passed}`} />
                    </span>
                  }
                />
                <CheckRow name="Vercel" avatar={<VercelMark />} state={<CheckPassed />} />
                <CheckRow
                  name="Vercel Preview Comments"
                  avatar={<VercelMark />}
                  state={<CheckPassed />}
                />
              </Section>
              <Section title="Comments" count={3}>
                <div className="flex flex-col gap-2">
                  <CommentRow
                    avatar={<VercelMark />}
                    author="vercel"
                    preview="The latest updates on your projects. Learn more about Vercel for GitHub."
                    age="46m"
                  />
                  <CommentRow
                    avatar={<GreptileGlyph className="size-2.5" />}
                    author="greptile-apps"
                    preview="Greptile Summary"
                    age="42m"
                  />
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
        }
      />
    </ScaledWindow>
  );
}

/// PR #44's glyph wherever it is drawn — the sidebar row, the titlebar tab and
/// the panel all turn from open to merged on the one clock.
function PrFace() {
  return (
    <span className="grid size-4 shrink-0">
      <PrOpenGlyph className={`col-start-1 row-start-1 ${s.open}`} />
      <PrMergedGlyph className={`col-start-1 row-start-1 ${s.merged}`} />
    </span>
  );
}
