import Orb from "@/components/app/Orb";
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
  Composer,
  ToolGroup,
  Transcript,
  Turn,
  UserBubble,
} from "@/components/app/Chat";
import { DragGhost, DropZone, PaneHeader } from "@/components/app/Split";
import Window from "@/components/app/Window";
import { ClaudeGlyph } from "@/components/ClaudeGlyph";
import { ScaledWindow } from "./ScaledWindow";
import s from "./SplitView.module.css";

const WIDTH = 1128;
const HEIGHT = 720;

/// The split view, drawn as the app draws it: one pane, then a sidebar row
/// dragged onto its right half splits it, then another dropped below the new
/// pane splits that — three conversations streaming in one window. Pieces are
/// the app's own (`components/app/`); the timing lives in the module CSS.
export function SplitView({ className }: { className?: string }) {
  return (
    <ScaledWindow width={WIDTH} height={HEIGHT} className={`${s.scene} ${className ?? ""}`}>
      <Window
        className="relative h-full w-full"
        sidebar={
          <Sidebar>
            <HeadingRow label="Group 1" />
            <SessionRow title="Window transparency" active trailing="31m" />
            <SessionRow title="Split screen multi-session" trailing="45m" />
            <SessionRow title="Browser tab auto-opens" trailing={<Orb aria-label="Working" />} />
            <GroupBreak />
            <HeadingRow label="ade" />
            <SessionRow title="Prepare new release" trailing="27m" />
            <GroupBreak />
            <HeadingRow label="yogesh" />
            <SessionRow title="Analyze recent Twitter" trailing="31 Aug" />
            <HintRow label="Switch tasks">
              <Keys caps={["⌘", "Shift", "⇅"]} className={HINT_KEYS} />
            </HintRow>
            <HintRow label="Switch groups">
              <Keys caps={["⌘", "⌥", "⇅"]} className={HINT_KEYS} />
            </HintRow>
          </Sidebar>
        }
        header={<ChatHeader project="Group 1" tabs={["Chat", "Diff", "Browser"]} />}
        main={
          <div className="relative flex h-full min-h-0 border-t border-hairline">
            {/* Column A: the pane that was here first, and the focused one. */}
            <div className={`relative flex min-w-0 flex-col overflow-hidden ${s.colA}`}>
              <PaneHeader
                project="ade"
                title="Window transparency percentage"
                branch="worktree-lucid-peach-sky"
                focused
              />
              <Transcript>
                <Turn>
                  <UserBubble>make dray dark 70.</UserBubble>
                  <ToolGroup label="2 tool calls" />
                  <AssistantText>
                    Dray dark is 70% — live in the dev window, and staged. Say the word and
                    I&apos;ll commit, push to PR #159, and fix the table in its body.
                  </AssistantText>
                </Turn>
              </Transcript>
              <Composer
                agent={<ClaudeGlyph className="size-3.5" />}
                model="Opus 5"
                effort="High"
                mode="Auto"
                context={0.28}
              />
              <DropZone region="right" label="Split right" className={s.zone1} />
            </div>

            {/* Column B: arrives on the first drop, splits on the second. */}
            <div className={`flex min-w-0 flex-col overflow-hidden border-l border-hairline-strong ${s.colB}`}>
              <div className={`relative flex min-h-0 flex-col overflow-hidden ${s.paneB}`}>
                <PaneHeader
                  project="ade"
                  title="Split screen multi-session view"
                  branch="worktree-lucid-plum-ember"
                />
                <Transcript>
                  <Turn>
                    <UserBubble>looks good. commit</UserBubble>
                    <ToolGroup className={s.lb1} label="Ran 2 commands" />
                    <AssistantText className={s.lb2}>
                      Committed as <Code>9fd81be0</Code> and pushed to PR #156.
                    </AssistantText>
                  </Turn>
                </Transcript>
                <DropZone region="bottom" label="Split below" className={s.zone2} />
              </div>
              <div className={`flex min-h-0 flex-col overflow-hidden border-t border-hairline-strong ${s.paneC}`}>
                <PaneHeader
                  project="ade"
                  title="Browser tab auto-opens side pane"
                  branch="worktree-fair-azure-lagoon"
                />
                <Transcript>
                  <Turn>
                    <UserBubble>check the build and mark the PR ready</UserBubble>
                    <ToolGroup className={s.lc1} label="3 tool calls" />
                    <AssistantText className={s.lc2}>
                      PR #157 is ready for review with no findings from the reviewer. Linear
                      will move DRA-184 to Done on merge.
                    </AssistantText>
                  </Turn>
                </Transcript>
              </div>
            </div>

            {/* The rows in flight, positioned against the pane grid. */}
            <DragGhost className={s.ghost1}>Split screen multi-session</DragGhost>
            <DragGhost className={s.ghost2}>Browser tab auto-opens</DragGhost>
          </div>
        }
      />
    </ScaledWindow>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 font-mono text-code">{children}</code>;
}
