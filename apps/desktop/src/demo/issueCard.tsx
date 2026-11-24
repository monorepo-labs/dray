import { mockIPC } from "@tauri-apps/api/mocks";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import BotTranscript from "@/components/chat/BotTranscript";
import { IssueCardChatContext } from "@/components/chat/IssueCard";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { issueStarts } from "@/lib/issueCard";
import type { AgentEvent, IssueCardRow } from "@/types/events";
import "../App.css";

/// A bot's chat with an issue card for several issues and one for a single
/// issue, through the real `BotTranscript` and `IssueCard`. Tiles: one
/// fill per issue, the number coloured by state; the play button waits as the server would, then
/// logs the hand-off, so the row turns Started.

const SESSION = "01a1cfc8-demo-issue-card";
let seq = 0;
const event = (payload: unknown): AgentEvent =>
  ({
    id: `e${seq}`,
    sessionId: SESSION,
    harness: "claude_code",
    seq: seq++,
    ts: new Date(Date.now() - 5 * 60_000 + seq * 1000).toISOString(),
    turnId: null,
    subagent: null,
    payload,
  }) as AgentEvent;

const user = (text: string) =>
  event({ type: "user_message", text, images: [], issues: [], baseline: null, queued: false, from: null, cwd: null });
const say = (text: string) => event({ type: "assistant_text", block: null, text });

const label = (name: string, color: string) => ({ name, color });
const BUG = label("bug", "#d73a4a");
const row = (number: number, title: string, labels: IssueCardRow["labels"], excerpt: string, closed = false): IssueCardRow => ({
  number,
  title,
  url: `https://github.com/acme/web/issues/${number}`,
  closed,
  labels,
  excerpt,
  author: { name: number % 2 ? "Maya Chen" : "Sam Ortiz", avatar: null },
});

const UPLOAD = row(
  142,
  "Crash when the upload is over 10 MB",
  [BUG, label("help wanted", "#008672")],
  "Uploading a file over 10 MB crashes the tab. Expected a friendly error or a chunked upload instead. Repro: drag a 12 MB PNG into the uploader.",
);

const EVENTS: AgentEvent[] = [
  user("What's open in acme/web that I could hand you?"),
  event({
    type: "issue_card",
    repo: "acme/web",
    issues: [
      row(138, "Login button does nothing on Safari", [BUG], "Tapping Log in on Safari 17 does nothing: no request goes out and no error shows. Chrome and Firefox work."),
      row(140, "Add dark mode to the settings page", [label("enhancement", "#a2eeef"), label("design", "#5319e7"), label("good first issue", "#7057ff")], "Settings ignores the system theme. Add a Light / Dark / System switch and persist the pick."),
      UPLOAD,
      row(129, "Document the deploy script", [label("documentation", "#0075ca")], "deploy.sh has no docs: what it needs, what it does, how to roll back.", true),
    ],
  }),
  say("The upload crash looks the most urgent. #129 is closed already."),
  user("What's #142 about exactly?"),
  event({ type: "issue_card", repo: "acme/web", issues: [UPLOAD] }),
  say("A 12 MB file takes the tab down. I'd add a size check before the upload and chunk anything over 8 MB."),
];

// Work on it reaches the server through `server_invoke`; here it waits as the
// round trip would and logs the hand-off the server would log.
let log: (e: AgentEvent) => void = () => {};
mockIPC(async (cmd, args) => {
  const call = cmd === "server_invoke" ? (args as { cmd: string; args: Record<string, unknown> }) : { cmd, args: args as Record<string, unknown> };
  if (call.cmd === "list_servers") return [];
  if (call.cmd !== "approve_issue") return null;
  await new Promise((r) => setTimeout(r, 700));
  log(event({ type: "issue_approved", cardId: call.args.cardId, number: call.args.number }));
  return null;
});

function Demo() {
  const [events, setEvents] = useState(EVENTS);
  useEffect(() => {
    log = (e) => setEvents((now) => [...now, e]);
  }, []);
  const starts = issueStarts(events);
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-4 p-10 pb-24">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">Issue card in a bot's chat</h1>
          <p className="text-ui text-muted-foreground">
            A row opens its issue in Dray
            in the app; the play button (Work on it) hands it to the bot and turns Started.
          </p>
          <div>
            <Button variant="outline" size="xs" onClick={() => setEvents(EVENTS)}>
              Reset Started
            </Button>
          </div>
        </div>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 rounded-xl border border-border px-6 py-6">
          <IssueCardChatContext value={{ starts, closed: false }}>
            <BotTranscript
              unread={false}
              segments={[{ sessionId: SESSION, harness: "claude_code", created: EVENTS[0].ts, events }]}
              busy={false}
              onOpenSession={() => {}}
            />
          </IssueCardChatContext>
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
