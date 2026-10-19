import Avatar from "@/components/app/Avatar";
import Crew, { CrewHint, CrewRow } from "@/components/app/Crew";
import Orb from "@/components/app/Orb";
import { PermissionCard } from "@/components/app/Permission";
import Sidebar, { GroupBreak, SessionRow, TaskHint } from "@/components/app/Sidebar";
import { PrMergedGlyph, PrOpenGlyph } from "@/components/app/Panel";
import { AddTab, BranchButton, ChatIcon, ItemTab, PanelToggle } from "@/components/app/Tabs";
import {
  AssistantText,
  Composer,
  ToolGroup,
  Transcript,
  Turn,
  UserBubble,
} from "@/components/app/Chat";
import Window from "@/components/app/Window";
import { ClaudeGlyph } from "@/components/ClaudeGlyph";
import { ScaledWindow } from "./ScaledWindow";
import s from "./Orchestration.module.css";

const WIDTH = 1128;
const HEIGHT = 760;

/// Orchestration, drawn as the app itself: one prompt in the middle, the
/// sidebar growing three sessions under the one that made them, and the crew
/// beside the conversation — a strip per child, one open on its own
/// transcript — each settling from orb to timestamp as it reports back. The
/// pieces are the app's own components (`components/app/`), so what moves is
/// the only thing this file adds; the timing lives in the module CSS.
export function Orchestration({ className }: { className?: string }) {
  return (
    <ScaledWindow width={WIDTH} height={HEIGHT} minScale={0.7} className={`${s.scene} ${className ?? ""}`}>
      <Window
        className="h-full w-full"
        sidebar={
          <Sidebar>
            <SessionRow
              title="Ship the onboarding flow"
              active
              opens
              unread="add"
              unreadClassName={`${s.done} ${s.doneP}`}
              trailing={<Settling spin={s.spinP} done={s.doneP} />}
            />
            <SessionRow
              title="Sign-in screen"
              depth={1}
              guides={[true]}
              className={s.row1}
              unread="add"
              unreadClassName={`${s.done} ${s.done1}`}
              trailing={<Settling spin={s.spin1} done={s.done1} />}
            />
            <SessionRow
              title="Onboarding copy"
              depth={1}
              guides={[true]}
              className={s.row2}
              unread="add"
              unreadClassName={`${s.done} ${s.done2}`}
              trailing={<Settling spin={s.spin2} done={s.done2} />}
            />
            <SessionRow
              title="Analytics events"
              depth={1}
              guides={[false]}
              className={s.row3}
              unread="add"
              unreadClassName={`${s.done} ${s.done3}`}
              trailing={<Settling spin={s.spin3} done={s.done3} />}
            />
            <GroupBreak />
            <SessionRow title="Landing page illustrations" trailing="2h" />
            <SessionRow title="Rate limit the share links" trailing="1d" />
            <GroupBreak />
            <SessionRow title="Draft sessions" pr={<PrOpenGlyph />} trailing="1d" />
            <GroupBreak />
            <SessionRow title="Spaces in the sidebar" pr={<PrMergedGlyph />} trailing="2d" />
            <TaskHint />
          </Sidebar>
        }
        tabs={
          <>
            <ItemTab icon={<ChatIcon />} label="ade / Ship the onboarding flow" plain />
            <AddTab />
          </>
        }
        headerEnd={
          <>
            <BranchButton name="calm-peach-nimbus" />
            <PanelToggle />
          </>
        }
        main={
          <>
            <Transcript>
              <Turn>
                <UserBubble>Split this into three sessions and run them in parallel.</UserBubble>
                <ToolGroup
                  className={s.group}
                  label={
                    // Three copies in one cell; the keyframes pick which shows.
                    <span className="grid">
                      <span className={`col-start-1 row-start-1 ${s.c1}`}>1 tool call</span>
                      <span className={`col-start-1 row-start-1 ${s.c2}`}>2 tool calls</span>
                      <span className={`col-start-1 row-start-1 ${s.c3}`}>3 tool calls</span>
                    </span>
                  }
                />
                <AssistantText className={s.text}>
                  Started three sessions, one worktree each. They&apos;ll report back here
                  when they finish.
                </AssistantText>
                <AssistantText className={s.final}>All three reported back.</AssistantText>
              </Turn>
            </Transcript>
            <Composer
              placeholder="Follow-up. @files. /skills. &tasks. #issues."
              mic
              agent={<ClaudeGlyph className="size-3.5" />}
              model="Opus 5.5"
              effort="High"
              mode="Auto"
              context={0.42}
            />
          </>
        }
        crew={
          <Crew>
            {/* `tone="add"` is the end state and the animation overrides it
                for the loop's first half, so reduced motion lands on the
                finished picture like everything else here. */}
            <CrewRow
              title="Sign-in screen"
              open
              tone="add"
              titleClassName={s.tone1}
              className={s.strip1}
              avatar={<Avatar name="sign-in-screen" />}
              trailing={<Working spin={s.spin1} />}
            >
              <Transcript>
                <Turn>
                  <UserBubble>
                    Build the sign-in screen with email and passkey, matching the
                    composer&apos;s card.
                  </UserBubble>
                  <ToolGroup className={s.line1} label="4 tool calls" />
                  <AssistantText className={s.line2}>
                    Added the form and wired the passkey branch behind the same submit.
                  </AssistantText>
                  <AssistantText className={s.line3}>
                    Done. Reporting back to the parent session.
                  </AssistantText>
                </Turn>
              </Transcript>
            </CrewRow>
            {/* This one stops to ask, the way a spawned session does at its
                first command: the card opens its own strip, one option is
                pressed, and the strip folds back to a row. */}
            <CrewRow
              title="Onboarding copy"
              open
              tone="add"
              titleClassName={s.tone2}
              className={s.strip2}
              avatar={<Avatar name="onboarding-copy" />}
              trailing={<Working spin={s.spin2} />}
            >
              <PermissionCard
                className={`mx-3 mb-3 ${s.card}`}
                argument="pnpm vitest run onboarding"
                description="Run this command?"
                options={[
                  { label: "Allow", kind: "once", className: s.press },
                  { label: "Always allow", kind: "always" },
                  { label: "Deny", kind: "deny" },
                ]}
              />
            </CrewRow>
            <CrewRow
              title="Analytics events"
              tone="add"
              titleClassName={s.tone3}
              className={s.strip3}
              avatar={<Avatar name="analytics-events" />}
              trailing={<Working spin={s.spin3} />}
            />
            <CrewHint />
          </Crew>
        }
      />
    </ScaledWindow>
  );
}

/// A sidebar row's right slot through its life: the orb while the session
/// works, the timestamp once it has reported. Both occupy one cell so the swap
/// moves nothing — the app's own rule for that slot.
function Settling({ spin, done }: { spin: string; done: string }) {
  return (
    <span className="grid justify-items-end">
      <span className={`col-start-1 row-start-1 flex items-center ${s.spin} ${spin}`}>
        <Orb />
      </span>
      <span className={`col-start-1 row-start-1 ${s.done} ${done}`}>now</span>
    </span>
  );
}

/// A crew strip's right slot: the orb while the session works, then nothing —
/// a finished child has no PR yet, so the slot goes empty as the app's does.
function Working({ spin }: { spin: string }) {
  return (
    <span className={`flex items-center ${s.spin} ${spin}`}>
      <Orb />
    </span>
  );
}
