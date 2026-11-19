import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";

import EventRow from "@/components/chat/EventRow";
import { MergeCardChatContext, MergeCardHostContext, type MergeCardHost } from "@/components/chat/MergeCard";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { useTheme } from "@/hooks/useTheme";
import { readerMessagesAfter } from "@/lib/mergeCard";
import type { AgentEvent, PrMark } from "@/types/events";
import "../App.css";

/// Merge cards in a chat, one per state a pull request can be in, through the
/// real `EventRow`, `MergeCard` and collapse rule. Merge waits a second and
/// marks the PR merged, as the sidebar's read does once `merge_pr` lands; Send
/// a message adds one of the reader's, so the third collapses the oldest
/// unmerged card.
let seq = 0;
const event = (payload: object): AgentEvent =>
  ({ id: `e${seq}`, sessionId: "chat", harness: "claude_code", seq: seq++, ts: "", turnId: null, subagent: null, payload }) as AgentEvent;

const said = (text: string) =>
  event({ type: "user_message", text, images: [], issues: [], baseline: null, queued: false, from: null, cwd: null });
const reply = (text: string) => event({ type: "assistant_text", block: null, text });
const card = (n: number, title: string) =>
  event({
    type: "merge_card",
    taskId: `01a1d000-0000-7000-8000-000000000${n}`,
    title,
    projectPath: "/repo",
    branch: `b${n}`,
    number: n,
    url: `https://github.com/acme/site/pull/${n}`,
  });

const pr = (number: number, more: Partial<PrMark> = {}): PrMark => ({
  number,
  url: `https://github.com/acme/site/pull/${number}`,
  headRefName: `b${number}`,
  isDraft: false,
  reviewDecision: null,
  state: "OPEN",
  checksState: "CLEAR",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  ...more,
});

const MARKS: PrMark[] = [
  pr(901, { state: "MERGED", mergeable: null, mergeStateStatus: null }),
  pr(912),
  pr(915, { checksState: "RUNNING", mergeStateStatus: "BLOCKED" }),
  pr(916, { checksState: "FAILING", mergeStateStatus: "UNSTABLE" }),
  pr(917, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
  pr(918, { isDraft: true, mergeStateStatus: "DRAFT" }),
];

const EVENTS: AgentEvent[] = [
  said("Bump Shiki and fix the pricing copy, then the rest."),
  reply("Shiki is merged already."),
  card(901, "Bump the Shiki version"),
  reply("The pricing copy fix is ready to merge."),
  card(912, "Fix the pricing page copy"),
  reply("The others are still going."),
  card(915, "Add dark mode to docs"),
  card(916, "Ship the changelog page"),
  card(917, "Rename the CLI flags"),
  card(918, "Draft the onboarding email"),
];

const NO_RESULTS = new Map();

// Ring widths side by side, each column wearing its own palette and mode the
// way a theme swatch does, so light and dark sit on one page. The page itself
// stays light: `dark:` variants match any `.dark` ancestor, which would reach
// into the light columns too.
const RINGS = [
  { mode: "light", width: "0.5px", ring: "0 0 0 0.5px oklch(0 0 0 / 6%), var(--shadow-card)" },
  { mode: "light", width: "1px", ring: "0 0 0 1px oklch(0 0 0 / 6%), var(--shadow-card)" },
  { mode: "dark", width: "0.5px", ring: "0 0 0 0.5px oklch(1 0 0 / 8%)" },
  { mode: "dark", width: "1px", ring: "0 0 0 1px oklch(1 0 0 / 8%)" },
] as const;
const COMPARE = [card(912, "Fix the pricing page copy"), card(917, "Rename the CLI flags")];

function Demo() {
  const [events, setEvents] = useState(EVENTS);
  const { setMode } = useTheme();
  useEffect(() => {
    setMode("light");
  }, [setMode]);
  const [marks, setMarks] = useState(MARKS);
  const chat = useMemo(() => ({ after: readerMessagesAfter(events), bot: true }), [events]);
  const host: MergeCardHost = {
    prNumbered: (_repo, number) => marks.find((m) => m.number === number),
    missing: () => {},
    titleOf: () => undefined,
    // #912 keeps a CI watch going past its turn; Merge still offers.
    tasksOf: (id) =>
      id.endsWith("912") ? [{ taskId: "b1", taskType: "local_bash", description: "Wait for the CI build" }] : [],
    mergeBlock: () => null,
    merge: async (c) => {
      await new Promise((done) => setTimeout(done, 1000));
      setMarks((all) => all.map((m) => (m.number === c.number ? { ...m, state: "MERGED" } : m)));
    },
    open: () => {},
    fixConflicts: () => new Promise((done) => setTimeout(done, 600)),
  };

  return (
    <TooltipProvider>
      <MergeCardHostContext value={host}>
        <MergeCardChatContext value={chat}>
          <div className="mx-auto flex max-w-3xl flex-col gap-4 p-10" data-bot-chat>
            <h1 className="text-lg font-medium">Ring width</h1>
          </div>
          <div className="grid grid-cols-2 gap-4 px-10 pb-6 xl:grid-cols-4">
            {RINGS.map((r) => (
              <div
                key={r.mode + r.width}
                data-theme="default"
                data-mode={r.mode}
                className={r.mode === "dark" ? "dark rounded-xl bg-(--background) text-foreground" : "rounded-xl bg-(--background) text-foreground"}
                // `--card` is an alias set at the root, so it resolved against the page's
                // light palette; naming it here makes it read this column's.
                style={
                  {
                    "--shadow-raised-card": r.ring,
                    "--card": "var(--surface-card)",
                    "--card-foreground": "var(--foreground)",
                  } as React.CSSProperties
                }
              >
                <div className="flex h-full flex-col gap-3 rounded-xl bg-(--surface-sheet) p-4">
                  <span className="text-ui text-muted-foreground">
                    {r.mode === "light" ? "Light" : "Dark"} · {r.width} ring
                  </span>
                  {COMPARE.map((e) => (
                    <EventRow key={e.id} event={e} resultByCallId={NO_RESULTS} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mx-auto flex max-w-3xl flex-col gap-4 p-10 pt-0" data-bot-chat>
            <h1 className="mt-6 text-lg font-medium">Merge cards</h1>
            <p className="text-ui text-muted-foreground">
              #912 is ready and draws Merge. #901 is merged, so it is one line. Send three messages and the unmerged
              cards collapse to a line that still carries Merge where it can.
            </p>
            <Button size="sm" className="self-start" onClick={() => setEvents((all) => [...all, said("Next thing.")])}>
              Send a message
            </Button>
            {events.map((e) => (
              <EventRow key={e.id} event={e} resultByCallId={NO_RESULTS} />
            ))}
          </div>
        </MergeCardChatContext>
      </MergeCardHostContext>
      <DemoThemeBar />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
