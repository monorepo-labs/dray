import React, { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";

import PullDetail from "@/components/PullDetail";
import PullsView, { type PullsScope } from "@/components/PullsView";
import RightPanel from "@/components/RightPanel";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { inboxRows, sessionsForPr, type InboxRow } from "@/lib/prInbox";
import type { PrComment, PrListing, PrMark, PullRequest, SessionIndexItem } from "@/types/events";
import "../App.css";

/// The pull requests page with every input faked: marks for two repos, the PR
/// details the pane reads, and the sessions they match. What a send would put
/// on the wire is drawn under the page, so the prompt itself can be read.
///
/// `send_msg` is the one command stubbed — `sendToTask` calls it — and the
/// stub records the prompt rather than sending it anywhere.
const sent: { sessionId: string; prompt: string }[] = [];
let onSent: () => void = () => {};
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (called: string, given: { cmd?: string; args?: { sessionId: string; prompt: string } }) => {
    // Everything but the app's own commands rides `server_invoke`.
    const cmd = called === "server_invoke" ? given.cmd : called;
    const args = (called === "server_invoke" ? given.args : given) as { sessionId: string; prompt: string };
    if (cmd === "send_msg") {
      await new Promise((r) => setTimeout(r, 400));
      sent.unshift({ sessionId: args.sessionId, prompt: args.prompt });
      onSent();
      return { snapshot: null, queued: null };
    }
    if (cmd === "list_open_apps") return [];
    if (cmd === "recheck_gh") return true;
    throw new Error(`demo: nothing stubbed for ${cmd}`);
  },
};

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const listing = (over: Partial<PrListing>): PrListing => ({
  title: "",
  author: "yogesharc",
  authorAvatar: null,
  updatedAt: ago(30),
  additions: 40,
  deletions: 8,
  commentCount: 0,
  isCrossRepository: false,
  viewerDidAuthor: true,
  reviewRequested: false,
  ...over,
});

const mark = (repo: string, number: number, over: Partial<PrMark>, l: Partial<PrListing>): PrMark => ({
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  headRefName: `worktree-pr-${number}`,
  isDraft: false,
  state: "OPEN",
  checksState: "CLEAR",
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  reviewDecision: "REVIEW_REQUIRED",
  ...over,
  listing: listing(l),
});

const DRAY = "/Users/you/code/dray";
const SITE = "/Users/you/code/site";

const MARKS: Record<string, PrMark[]> = {
  [DRAY]: [
    mark("monorepo-labs/dray", 1340, { checksState: "FAILING" }, {
      title: "Pull requests page: every PR in one place",
      updatedAt: ago(4),
      commentCount: 4,
      additions: 812,
      deletions: 40,
    }),
    mark("monorepo-labs/dray", 1338, { mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" }, {
      title: "Prefetch a bot chat's transcript on hover",
      updatedAt: ago(25),
      commentCount: 2,
    }),
    mark("monorepo-labs/dray", 1335, { checksState: "RUNNING" }, {
      title: "Add dray session detach, so a bot can hand a task to the user",
      updatedAt: ago(60),
    }),
    mark("monorepo-labs/dray", 1324, { headRefName: "fix/bot-panel" }, {
      title: "Bot chat panel: icon switcher at the bottom",
      viewerDidAuthor: false,
      author: "ada",
      reviewRequested: true,
      updatedAt: ago(180),
      commentCount: 1,
    }),
    mark("monorepo-labs/dray", 1301, { headRefName: "patch-1" }, {
      title: "Fix a typo in the README",
      viewerDidAuthor: false,
      author: "drive-by",
      isCrossRepository: true,
      updatedAt: ago(60 * 26),
    }),
    mark("monorepo-labs/dray", 1290, { isDraft: true }, {
      title: "Spike: island on Windows",
      updatedAt: ago(60 * 50),
    }),
  ],
  [SITE]: [
    mark("monorepo-labs/site", 88, { mergeStateStatus: "CLEAN" }, {
      title: "Docs: the pull requests page",
      updatedAt: ago(90),
    }),
  ],
};

const session = (sessionId: string, title: string, branch: string, over: Partial<SessionIndexItem> = {}) =>
  ({
    sessionId,
    title,
    projectPath: DRAY,
    cwd: `${DRAY}/.claude/worktrees/${branch}`,
    branch,
    worktreeName: null,
    worktreeRemoved: false,
    archived: false,
    hidden: false,
    modified: ago(5),
    harness: "claude_code",
    model: "claude-opus-5-5",
    effort: "high",
    permissionMode: "auto",
    fast: false,
    ...over,
  }) as SessionIndexItem;

const SESSIONS: SessionIndexItem[] = [
  session("s-1340", "Plan and build the pull requests page", "worktree-pr-1340"),
  session("s-1338", "Hover prefetch for bot chats", "worktree-pr-1338"),
  session("s-1338b", "Review the hover prefetch", "worktree-pr-1338", { modified: ago(40) }),
  session("s-1335", "dray session detach", "worktree-pr-1335", { archived: true }),
];

const comment = (over: Partial<PrComment>): PrComment => ({
  id: "",
  author: "greptile-apps[bot]",
  avatar: null,
  body: "",
  createdAt: ago(20),
  url: "https://github.com/monorepo-labs/dray/pull/1340",
  kind: "comment",
  path: null,
  resolved: false,
  replies: [],
  ...over,
});

function detail(row: InboxRow): PullRequest {
  const url = row.mark.url;
  return {
    number: row.mark.number,
    title: row.listing.title,
    url,
    state: "OPEN",
    isDraft: row.mark.isDraft,
    author: row.listing.author,
    baseRefName: "main",
    headRefName: row.mark.headRefName,
    headRefExists: true,
    isCrossRepository: row.listing.isCrossRepository,
    mergeable: row.mark.mergeable ?? "UNKNOWN",
    mergeStateStatus: row.mark.mergeStateStatus ?? "UNKNOWN",
    reviewDecision: row.mark.reviewDecision,
    additions: row.listing.additions,
    deletions: row.listing.deletions,
    changedFiles: 6,
    updatedAt: row.listing.updatedAt,
    checks: [
      { name: "test", state: row.mark.checksState === "FAILING" ? "failure" : "success", url: null, workflow: "CI", avatar: null },
      { name: "Vercel", state: row.mark.checksState === "RUNNING" ? "pending" : "success", url: null, workflow: null, avatar: null },
    ],
    comments: [
      comment({
        id: "IC_1",
        body: "## Summary\nAdds a pull requests page under Issues.\n\n**Confidence: 4/5**",
        url: `${url}#issuecomment-1`,
        createdAt: ago(50),
      }),
      comment({
        id: "PRR_1",
        kind: "changes_requested",
        author: "greptile-apps[bot]",
        url: `${url}#pullrequestreview-1`,
        createdAt: ago(30),
        replies: [
          comment({
            id: "PRRC_1",
            path: "apps/desktop/src/App.tsx:1612",
            body: "`pullsErrors` is rebuilt on every render.\nMemoise it beside `pullsMissing`.",
            url: `${url}#discussion_r1`,
            createdAt: ago(30),
            replies: [
              comment({
                id: "PRRC_2",
                author: "yogesharc",
                body: "agreed, will move it",
                url: `${url}#discussion_r2`,
                createdAt: ago(10),
              }),
            ],
          }),
          comment({
            id: "PRRC_3",
            path: "apps/desktop/src/lib/prInbox.ts:88",
            body: "A fork's head could match a local branch of the same name.",
            url: `${url}#discussion_r3`,
            resolved: true,
            createdAt: ago(29),
          }),
        ],
      }),
      comment({
        id: "IC_2",
        author: "yogesharc",
        body: "Looks good apart from the memo.",
        url: `${url}#issuecomment-2`,
        createdAt: ago(8),
      }),
    ],
  };
}

function Demo() {
  const [scope, setScope] = useState<PullsScope>("space");
  const [picked, setPicked] = useState<InboxRow | null>(null);
  const [, setTick] = useState(0);
  onSent = () => setTick((n) => n + 1);

  const [owner, setOwner] = useState<string | null>(null);
  const keys = scope === "space" ? [DRAY] : [DRAY, SITE];
  const rows = useMemo(() => inboxRows(keys, (key) => MARKS[key]), [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const sessionsFor = (row: InboxRow) => sessionsForPr(row, SESSIONS, () => undefined);
  const pr = picked && detail(picked);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col">
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col bg-background">
            <PullsView
              rows={rows}
              loaded
              hasRepos
              missing={null}
              errors={scope === "mine" ? [{ name: "site", error: { kind: "other", detail: "API rate limit exceeded" } }] : []}
              scope={scope}
              owners={["ada", "acme"]}
              owner={owner}
              onOwner={setOwner}
              onScope={setScope}
              sessionsFor={sessionsFor}
              botOf={() => undefined}
              onOpenSession={(item) => alert(`Would open ${item.title}`)}
              picked={picked}
              onPick={setPicked}
              loading={false}
              onRefresh={() => {}}
            />
          </main>
          <RightPanel open={!!picked} heading="Details" tab="pr" onTabChange={() => {}} refresh={{ onRefresh: () => {}, loading: false }}>
            {picked && pr && (
              <PullDetail
                key={picked.mark.url}
                row={picked}
                data={{ prs: [pr], error: null, loading: false, acting: null, act: async () => {}, refresh: () => {} }}
                sessions={sessionsFor(picked)}
                bots={[]}
                botOf={() => undefined}
                server="local"
                checkout={{ kind: "here", path: "/demo" }}
                machines={{ projects: [], clones: [], initial: "" }}
                onOpenSession={(item) => alert(`Would open ${item.title}`)}
                onStart={async (prompt) => {
                  sent.unshift({ sessionId: `new session on ${picked.mark.headRefName}`, prompt });
                  onSent();
                  return { error: "The demo starts nothing; the prompt is below." };
                }}
              />
            )}
          </RightPanel>
        </div>
        <pre
          data-testid="last-prompt"
          className="max-h-56 shrink-0 overflow-auto border-t border-border bg-surface-well p-3 text-xs whitespace-pre-wrap"
        >
          {sent[0] ? `→ ${sent[0].sessionId}\n\n${sent[0].prompt}` : "Nothing sent yet. Pick a PR, pick comments, write, Send."}
        </pre>
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
