"use client";

import { useState } from "react";
import { FileCode2 } from "lucide-react";

import { PrIcon } from "@/components/app/Bot";
import Orb from "@/components/app/Orb";
import Panel, { CheckPassed, CheckRow, CheckRunning, CommentRow, PrRow, Readiness, Section, VercelMark } from "@/components/app/Panel";
import { GreptileGlyph } from "@/components/GreptileGlyph";
import type { Task } from "./BotScene";

const PANEL_BUTTON =
  "flex h-7 items-center rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/// A task's own side panel, as the app draws it for any session: its pull
/// request where it has one, what it changed, and its to-do list. A bot's
/// Tasks tab belongs to the bot's chat, never here.
export function TaskPanel({
  task,
  merging,
  onConfirm,
}: {
  task: Task;
  merging: boolean;
  onConfirm: () => void;
}) {
  const tabs = [...(task.pr ? ["PR"] : []), "Changes", "More"];
  const [tab, setTab] = useState(tabs[0]);
  return (
    <Panel tabs={tabs} active={tab} onSelect={setTab} width={380}>
      {tab === "PR" && task.pr && <PrBody task={task} merging={merging} onConfirm={onConfirm} />}
      {tab === "Changes" && <ChangesBody task={task} />}
      {tab === "More" && <MoreBody task={task} />}
    </Panel>
  );
}

function PrBody({ task, merging, onConfirm }: { task: Task; merging: boolean; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const pr = task.pr!;
  const ready = !pr.running;
  const added = task.changes.reduce((n, f) => n + f.added, 0);
  const removed = task.changes.reduce((n, f) => n + f.removed, 0);
  return (
    <>
      <PrRow number={pr.number} title={task.title} added={added} removed={removed} glyph={<PrIcon pr={pr} className="size-4" />} />
      <div className="flex flex-col gap-4 pb-3">
        {/* A merged PR has nothing left to decide, so the verdict and its
            button go with it. */}
        {pr.state !== "merged" && (
          <Readiness
            tone={ready ? "ready" : "pending"}
            ready={ready}
            base="main"
            label={ready ? "Ready to merge" : "Checks running"}
            onMerge={() => setConfirming(true)}
            action={
              // The least reversible control on the pane asks once.
              merging ? (
                <span className={`${PANEL_BUTTON} bg-accent-merge text-accent-merge-foreground opacity-60`}>Merging…</span>
              ) : confirming ? (
                <>
                  <button type="button" onClick={() => setConfirming(false)} className={`${PANEL_BUTTON} hover:bg-muted/70`}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(false);
                      onConfirm();
                    }}
                    className={`${PANEL_BUTTON} bg-accent-merge text-accent-merge-foreground shadow-[0_1px_4px_rgba(0,0,0,0.35)] hover:bg-accent-merge-hover`}
                  >
                    Confirm squash and merge
                  </button>
                </>
              ) : undefined
            }
          />
        )}
        <Section title="Checks" count={ready ? "2 passed" : "1 running · 1 passed"}>
          <CheckRow
            name="Greptile Review"
            avatar={<GreptileGlyph className="size-2.5" />}
            state={ready ? <CheckPassed /> : <CheckRunning />}
          />
          <CheckRow name="Vercel" avatar={<VercelMark />} state={<CheckPassed />} />
        </Section>
        {ready && (
          <Section title="Comments" count={2}>
            <div className="flex flex-col gap-2">
              <CommentRow avatar={<GreptileGlyph className="size-2.5" />} author="greptile-apps" preview="Greptile Summary" age="12m" />
              <CommentRow avatar={<GreptileGlyph className="size-2.5" />} author="greptile-apps" word="reviewed" age="12m" />
            </div>
          </Section>
        )}
      </div>
    </>
  );
}

/// What the task changed. The directory is muted ahead of the name, so it
/// is what a narrow pane cuts.
function ChangesBody({ task }: { task: Task }) {
  if (task.changes.length === 0) return <p className="px-4 py-6 text-ui text-muted-foreground">No changes yet.</p>;
  return (
    <div className="flex flex-col">
      {task.changes.map((file) => (
        <div key={file.dir + file.name} className="flex items-center gap-2 border-b border-border px-3 py-2.5 text-ui">
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

/// The More tab: the task's to-do list, ticked as it goes, the open item
/// spinning while the task works.
function MoreBody({ task }: { task: Task }) {
  const next = task.todos.findIndex((t) => !t.done);
  return (
    <div className="flex flex-col">
      <div className="px-3 pt-3 pb-2 text-ui text-muted-foreground">Tasks</div>
      <ul className="flex flex-col gap-1.5 px-3 pb-3">
        {task.todos.map((todo, i) => (
          <li
            key={todo.text}
            className={`flex items-start gap-2 text-chat leading-snug ${todo.done ? "text-muted-foreground" : "text-foreground"}`}
          >
            {todo.done ? (
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
            ) : i === next && task.working ? (
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                <Orb size={16} />
              </span>
            ) : (
              <span className="mt-0.5 size-4 shrink-0 rounded-[6px] border border-muted-foreground/40" />
            )}
            {todo.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
