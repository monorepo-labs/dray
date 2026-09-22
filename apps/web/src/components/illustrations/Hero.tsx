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
import Sidebar, {
  GroupBreak,
  HINT_KEYS,
  HeadingRow,
  HintRow,
  Keys,
  SessionRow,
} from "@/components/app/Sidebar";
import {
  AssistantText,
  ChatHeader,
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
          <Sidebar>
            <HeadingRow label="Pinned" />
            <SessionRow title="Linear Agent" opens trailing="19h" />
            <SessionRow title="Settings theme picker" depth={1} guides={[false]} trailing="18h" />
            <GroupBreak />
            <HeadingRow label="ade" />
            <SessionRow title="Fix PR panel comments" trailing={<Orb aria-label="Working" />} />
            <SessionRow title="Add app speedrun" unread="add" trailing="5m" />
            <SessionRow title="Stop background tasks" active trailing="6m" />
            <GroupBreak />
            <HeadingRow label="yogesh" />
            <SessionRow title="Test run and greeting" trailing="1d" />
            <HintRow label="Switch tasks">
              <Keys caps={["⌘", "Shift", "⇅"]} className={HINT_KEYS} />
            </HintRow>
          </Sidebar>
        }
        header={
          <ChatHeader
            project="ade"
            title="Stop background tasks"
            branch="worktree-fleet-crimson-fjord"
            tabs={["Chat", "Changes"]}
          />
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
              agent={<ClaudeGlyph className="size-3.5" />}
              model="Fable 5"
              effort="High"
              mode="Auto"
              context={0.31}
            />
          </>
        }
        panel={
          <Panel tabs={["PR", "Changes", "Subagents"]} active="PR" counts={{ Subagents: 13 }} width={410}>
            <PrRow
              number={44}
              title="Stop background tasks holding the turn open"
              added={275}
              removed={70}
              glyph={
                <span className="grid size-4 shrink-0">
                  <PrOpenGlyph className={`col-start-1 row-start-1 ${s.open}`} />
                  <PrMergedGlyph className={`col-start-1 row-start-1 ${s.merged}`} />
                </span>
              }
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
