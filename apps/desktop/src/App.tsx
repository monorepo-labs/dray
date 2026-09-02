import { useEffect, useMemo, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

import "./App.css";
import Chat from "@/components/Chat";
import ChangesPanel from "@/components/ChangesPanel";
import ChangesView from "@/components/changes/ChangesView";
import ChatInput from "@/components/ChatInput";
import DiffWorkerPool from "@/components/DiffWorkerPool";
import DocsPanel from "@/components/DocsPanel";
import NoticeStack from "@/components/NoticeStack";
import QuitDialog from "@/components/QuitDialog";
import SettingsDialog, { type SettingsTab } from "@/components/SettingsDialog";
import WorktreeDialog, { type WorktreePrompt } from "@/components/WorktreeDialog";
import IssuePanel from "@/components/IssuePanel";
import IssuesView from "@/components/IssuesView";
import PrPanel from "@/components/PrPanel";
import { useChanges } from "@/hooks/useChanges";
import { usePrMarks } from "@/hooks/usePrMarks";
import { usePrReady } from "@/hooks/usePrReady";
import { useWorkStatus } from "@/hooks/useWorkStatus";
import HandoffRow from "@/components/composer/HandoffRow";
import { handoffActions } from "@/lib/handoff";
import { prTabVisible, usePullRequest } from "@/hooks/usePullRequest";
import RightPanel, {
  PanelToggle,
  TabBody,
  tabOrder,
  type PanelTab,
} from "@/components/RightPanel";
import Sidebar, {
  SidebarToggle,
  filterSessions,
  sortSessions,
} from "@/components/Sidebar";
import SubagentPanel from "@/components/SubagentPanel";
import ComposerToolbar from "@/components/composer/ComposerToolbar";
import DictateControl from "@/components/composer/DictateControl";
import AppShell from "@/components/layout/AppShell";
import SessionHeader from "@/components/layout/SessionHeader";
import { nextEffort } from "@/components/composer/ModelSelector";
import { nextHarness } from "@/lib/model";
import { cycledModels } from "@/lib/starredModels";
import ViewTabs, { type ViewTab } from "@/components/layout/ViewTabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { pickAttachments } from "@/hooks/useAttachments";
import { useCodeTheme } from "@/hooks/useCodeTheme";
import { refreshActiveDoc, saveActiveDoc, useDocs } from "@/hooks/useDocs";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useGlass } from "@/hooks/useGlass";
import { warmHighlighter } from "@/hooks/useHighlighter";
import { useHotkey } from "@/hooks/useHotkey";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { pushNotice } from "@/hooks/useNotices";
import { useIntegrations } from "@/hooks/useIntegrations";
import { useSessionIssues } from "@/hooks/useIssues";
import { useSessions } from "@/hooks/useSessions";
import { useAgentAvailability, useMissingAgent } from "@/hooks/useAgentAvailability";
import AgentMissingNotice from "@/components/composer/AgentMissingNotice";
import LoginExpiredNotice from "@/components/composer/LoginExpiredNotice";
import type { Issue, WorktreeDisposition } from "@/types/events";
import { useSlashCommands } from "@/hooks/useSlashCommands";
import { useRecorder } from "@/hooks/useTranscription";
import { useUpdater } from "@/hooks/useUpdater";
import { appendToDraft } from "@/hooks/useDraft";
import { issueTag } from "@/lib/issue";
import { authFailedTurn } from "@/lib/auth";
import { focusComposer } from "@/lib/composerFocus";
import { changeRange, turnChangedTree } from "@/lib/changes";
import { prBadgeCount, sessionBranch } from "@/lib/pr";
import { playCelebration } from "@/lib/sound";
import { worktreeNoticeDetail } from "@/lib/worktree";
import { buildTranscript } from "@/lib/transcript";
import { cn } from "@/lib/utils";

function App() {
  const {
    selectedSessionId,
    selectedSession,
    streamingContentBlock,
    sessionIndexItems,
    statusBySession,
    askingSessions,
    showArchived,
    setShowArchived,
    models,
    refreshModels,
    loadingModels,
    harness,
    setHarness,
    modelId,
    effort,
    permissionMode,
    projects,
    projectPath,
    branches,
    branch,
    useWorktree,
    busy,
    backgroundTasks,
    liveTaskIds,
    tasksBySession,
    compacting,
    apiRetry,
    working,
    contextUsage,
    error,
    setError,
    handleModelChange,
    setPermissionMode,
    handleAttachProject,
    handleSelectProject,
    handleSelectBranch,
    pendingBranch,
    setPendingBranch,
    runCheckout,
    setUseWorktree,
    handleSendMsg,
    handleInterrupt,
    handleStopTask,
    queuedMessages,
    handleCancelQueued,
    handleRespondPermission,
    handleAnswerQuestions,
    handleSelectSessionIndexItem,
    handleNewSession,
    setSessionFlags,
    forkSession,
    unlinkIssue,
    detachSession,
    deleteSession,
    removeWorktree,
  } = useSessions();

  // Whether the agent the composer is pointed at can actually be run. Null
  // while the first read is out and null when it is installed — both mean
  // there is nothing to say, so the composer sends as it always did.
  const missingAgent = useMissingAgent(harness);

  // The turn that died for want of a login, and whether the reader has already
  // been handed the cure for that one. Held by event id rather than by session:
  // a second failure mints a new id, so the notice comes back on its own
  // without anything having to clear a flag.
  const authTurn = useMemo(
    () => authFailedTurn(selectedSession?.events ?? []),
    [selectedSession?.events],
  );
  const [loginHandled, setLoginHandled] = useState<string | null>(null);
  // `useAgentAvailability` rather than `useMissingAgent`: that one answers only
  // for a CLI that is absent, and this agent's CLI ran well enough to report
  // being logged out.
  const agents = useAgentAvailability();
  const loggedOutAgent =
    authTurn && authTurn !== loginHandled
      ? (agents?.find((agent) => agent.harness === harness) ?? null)
      : null;

  const [collapsed, setCollapsed] = useLocalStorage("ade.sidebarCollapsed", false);
  // The sidebar's scope, not the composer's: `projectPath` decides where a new
  // session runs, and switching what you're *looking at* must not quietly move
  // where the next prompt would land.
  const [projectFilter, setProjectFilter] = useLocalStorage<string | null>(
    "ade.projectFilter",
    null,
  );
  const {
    status: updateStatus,
    manual: updateManual,
    install: installUpdate,
    checkNow: checkForUpdates,
    channel: updateChannel,
    setChannel: setUpdateChannel,
  } = useUpdater();

  // Every session the app has started this run, not the open one: the install
  // relaunches the app, so any live child is one this would kill mid-turn — or
  // mid-task, since a background task outlives its turn. A session from a
  // previous run cannot still be running — no child survives a restart — so
  // the two live maps answer this on their own.
  const anyRunning =
    Object.values(statusBySession).some((s) => s === "in_progress") ||
    Object.values(tasksBySession).some((tasks) => tasks.length > 0);

  const [panelOpen, setPanelOpen] = useState(false);
  // `null` is "never picked", and it is the whole of the default-tab rule.
  // Storing `"changes"` as the initial value made a fresh install
  // indistinguishable from a reader who had chosen Changes, so an open PR could
  // never lead — see `activeTab`.
  const [panelTab, setPanelTab] = useLocalStorage<PanelTab | null>("ade.panelTab", null);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);

  // Per session, and deliberately not persisted the way `panelTab` is: which
  // view you were last on is working context for one session rather than a
  // standing preference, and reopening the app onto a repo view for every
  // session would be wrong more often than right.
  const [viewTabs, setViewTabs] = useState<Record<string, ViewTab>>({});
  // Whether the issues page is what the main column is showing. Not a session
  // and not a per-session tab, so it is neither in `viewTabs` nor in the
  // selection: it is a place the reader goes and comes back from, and the
  // session they were in is still there when they do.
  const [issuesOpen, setIssuesOpen] = useState(false);

  /// The issues page's own refresh, so ⌘R can reach it. A ref rather than
  /// state: the page owns the read and hands its handle up, and re-rendering
  /// the whole app every time that handle is re-made would be a render per
  /// keystroke in the page's search box.
  const issuesRefreshRef = useRef<(() => void) | null>(null);

  /// The issue the pane is showing while the issues page has the column.
  ///
  /// Kept as the whole row rather than an identifier: the list already read
  /// every field a header draws, so the pane can be complete before its own
  /// detail read lands — the same bargain the session panel makes with a
  /// session's links.
  const [pickedIssue, setPickedIssue] = useState<Issue | null>(null);

  /// Whether the right pane is actually on screen, as against whether the
  /// reader has asked for it.
  ///
  /// Two different questions, and conflating them was a bug worth naming: the
  /// issues page fills the main column, so a pane left open beside it went on
  /// describing the session the reader had *left* — its changes, its pull
  /// request, its issue — with nothing on screen to say whose they were. The
  /// preference is kept, so coming back restores the pane exactly as it was;
  /// everything that draws or reads reads this instead.
  const panelShown = panelOpen && !issuesOpen;

  /// The picked issue as a link, which is the shape the panel reads.
  ///
  /// Memoized because it is an array: a fresh one each render would re-run the
  /// detail read on every keystroke in the page's search box.
  const pickedIssueRefs = useMemo(
    () =>
      pickedIssue
        ? [
            {
              tracker: pickedIssue.tracker,
              id: pickedIssue.id,
              identifier: pickedIssue.identifier,
              title: pickedIssue.title,
              url: pickedIssue.url,
            },
          ]
        : [],
    [pickedIssue],
  );

  const pickedIssueData = useSessionIssues(pickedIssueRefs, issuesOpen && !!pickedIssue);

  // Owned here rather than by any one surface: the settings row, the issues
  // page's own connect form and the composer's placeholder all read it, and a
  // hook per surface is a second answer to "are we connected" free to disagree
  // with the first.
  const integrations = useIntegrations(true);
  const issuesConnected = !!integrations.integrations?.linear;

  // Not persisted: settings are opened to change something and closed again, so
  // reopening the app into them would be the app remembering the wrong half of
  // a session.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which tab the *next* open lands on. Reset to Appearance as settings close,
  // so a mic press that sent the reader to Transcription does not leave every
  // later ⌘, opening there too.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");

  // Dictation writes into the composer's draft through the module-level store,
  // not through a prop: the controls reach `ChatInput` as an opaque node, so
  // they cannot hand it the text. Same bargain `useAttachments` makes.
  //
  // A press with no model downloaded opens settings on Transcription rather
  // than pulling hundreds of megabytes nobody asked for.
  const recorder = useRecorder({
    // Pinned when recording starts, so a dictation survives switching sessions
    // and still lands where it was spoken. Drafts are per session, so it is
    // waiting there on the way back.
    target: selectedSessionId,
    onText: (text, session) => {
      appendToDraft(session, text);
      // Straight back to typing: the words landed in a draft the reader is
      // most likely about to add to or send. Only where they are still looking
      // at the session they spoke into — a dictation outlives the screen it
      // began on, and focusing a composer holding somebody else's draft is
      // worse than not focusing at all.
      if (session === selectedSessionId) focusComposer();
    },
    onNeedsModel: () => {
      setSettingsTab("transcription");
      setSettingsOpen(true);
    },
    // Drawn in the composer's own error slot, which is where every other thing
    // that went wrong with a message already reports.
    onMessage: setError,
  });

  // ⌘ only. `platformOnly` is what keeps this off ⌃D, which macOS already
  // assigns to delete-forward in every text field — including the composer this
  // shortcut is for. Enabled always: pressed with nothing downloaded it opens
  // settings, which is the answer the reader needs rather than a dead key.
  useHotkey("d", () => void recorder.toggle(), { platformOnly: true });

  const [worktreePrompt, setWorktreePrompt] = useState<WorktreePrompt | null>(null);

  // Reads what the removal would cost *before* deciding whether to ask, so a
  // worktree that isn't there any more — deleted by hand, or by a `claude` run
  // that had an exit prompt of its own — is tidied up without a question.
  // Asking about a directory the reader can no longer see is a question with
  // one answer.
  //
  // `ask` is the whole difference between the two routes in. Settling raises a
  // notice that expires into "keep it", because the reader was doing something
  // else and this is an offer. The settled bar's own button raises the dialog,
  // because there the reader asked for the deletion and is owed a confirm
  // naming what it costs.
  const askAboutWorktree = async (
    sessionId: string,
    worktreeName: string,
    title: string,
    ask: "notice" | "dialog",
  ) => {
    let disposition: WorktreeDisposition;
    try {
      disposition = await invoke<WorktreeDisposition>("worktree_disposition", { sessionId });
    } catch {
      // An offer, not a step: a session whose state can't be read keeps its
      // worktree and says nothing. The button on the settled bar is still
      // there to try again.
      return;
    }

    if (!disposition.exists) {
      // Skipping the question is right either way — there is nothing left to
      // weigh — but *who asked* still decides whether a failure is reported.
      // The dialog route is a button the reader pressed and watched close, so
      // a relocation that then fails has to say so, or that press is the click
      // with nothing to show for it this whole change is about. Settling asked
      // for nothing and hears nothing.
      removeWorktree(sessionId, ask === "dialog" ? "asked" : "tidy");
      return;
    }

    if (ask === "dialog") {
      setWorktreePrompt({ sessionId, worktreeName, disposition });
      return;
    }

    pushNotice({
      sessionId,
      kind: "worktree",
      // The action leads. This card arrives unasked-for while the reader is
      // doing something else, so the first line has to be what it wants rather
      // than what happened — "Settled …" reads as a receipt, and a receipt is
      // something you look away from.
      label: "Delete worktree?",
      detail: worktreeNoticeDetail(disposition),
      // Which task, named by its own title rather than the generated worktree
      // name: `calm-navy-beacon` names a directory the reader never chose,
      // where the title is the work they just settled.
      subject: title,
    });
  };
  const viewTab: ViewTab = selectedSessionId ? viewTabs[selectedSessionId] ?? "chat" : "chat";
  const setViewTab = (tab: ViewTab) => {
    if (selectedSessionId) setViewTabs((prev) => ({ ...prev, [selectedSessionId]: tab }));
  };

  // Themes and Shiki's engine are shared by every code surface, so they load
  // once here instead of on the first diff the user happens to open.
  const { pair: codeThemePair } = useCodeTheme();
  useEffect(() => warmHighlighter(codeThemePair), [codeThemePair]);

  // The chat derives this too, but the panel and the header count need it here
  // and the memo makes the second pass free.
  const { subagents, resultByCallId } = useMemo(
    // Same `busy` and task set the chat passes. Left off, a subagent's
    // in-flight call would show in the panel as one that never finished.
    () => buildTranscript(selectedSession?.events ?? [], busy, liveTaskIds),
    [selectedSession?.events, busy, liveTaskIds],
  );

  // What the composer's handoff row draws itself from, and — one line down —
  // which branch the pull requests are looked up by. Read on the same falling
  // edge as those, since a turn is what moves all of it.
  const { status: workStatus } = useWorkStatus(selectedSession?.cwd ?? "", busy);

  // Filtered here rather than inside the sidebar, so the list and the ⌘⇧↑/↓ walk
  // read one array. `projectPath` on the item is the repo root, so a worktree
  // session stays under the project it forked from.
  const visibleSessions = useMemo(
    () =>
      projectFilter
        ? sessionIndexItems.filter((i) => i.projectPath === projectFilter)
        : sessionIndexItems,
    [sessionIndexItems, projectFilter],
  );

  // The search narrows what is drawn, and only that — the sidebar's own row is
  // where it is typed, but the list it filters is this one, so the ⌘⇧↑/↓ walk
  // below steps exactly the rows on screen.
  //
  // Layered over `visibleSessions` rather than folded into it, deliberately: the
  // marks and the ready-to-merge notice read that list to decide what to watch,
  // and a session dropping out of it as a query is typed would stop its repo
  // being polled and make the notice forget a pull request was already ready.
  const [search, setSearch] = useState("");
  const searchedSessions = useMemo(
    () => filterSessions(visibleSessions, search),
    [visibleSessions, search],
  );

  // The sidebar's marks: one `gh` per repo on screen rather than one per row —
  // see `usePrMarks`. Distinct paths, and the *active* list's only: a settled
  // session is work the reader has already dealt with, so a repo that appears
  // nowhere but the archived list is one nobody is waiting to land. Marks
  // already fetched still draw over there, since the cache outlives this — what
  // is dropped is the spending, not the answer.
  const repoPaths = useMemo(
    () => (showArchived ? [] : [...new Set(visibleSessions.map((i) => i.projectPath))]),
    [showArchived, visibleSessions],
  );
  const prMarks = usePrMarks(repoPaths);

  // "This can land now" — raised off the sidebar's marks rather than the
  // panel's own read, which is the only way it can be noticed at all: the
  // panel's poll is gated on its tab being on screen, and a tab on screen is
  // exactly the case with nothing to announce.
  usePrReady({ sessions: visibleSessions, prFor: prMarks.prFor });

  // Read here rather than inside the panel: the tab row needs to know whether
  // there is an open PR before that tab has ever been shown, so ordering it
  // first can't wait on the panel fetching for itself.
  //
  // `workStatus.branch` is git's own reading of HEAD and outranks the name the
  // index carries, which is only ever a guess made at creation — see
  // `sessionBranch`. It lands a frame late and the fallback covers that frame.
  const prBranch = selectedSession
    ? sessionBranch(selectedSession, workStatus?.branch)
    : null;
  // "The PR tab is on screen", read off the *pick* rather than off `activeTab`,
  // which cannot exist yet — it is derived from this hook's own answer. An
  // unset pick counts, since the derived default is the PR tab whenever there
  // is an open one. The one case the two disagree is a session whose only PRs
  // are merged: the pick is unset, the default resolves to Changes, and this
  // reads true — harmless, because a merged PR never settles and the poll is
  // gated on that too.
  const pullRequests = usePullRequest(
    selectedSession?.cwd ?? "",
    prBranch,
    panelShown && (panelTab === "pr" || panelTab === null),
    // A pull request appearing is the moment the session stops being about the
    // turn and starts being about landing, so the pane opens onto it rather
    // than waiting to be asked. Fires at most once per PR — see `onOpened`.
    //
    // It moves the pick as well as opening the pane, and has to: `activeTab`
    // honours a standing pick over the derived default, and the pick is written
    // by the app itself — `handleTogglePanel` stores "changes" every time the
    // pane is opened onto a turn that touched files. So opening alone landed on
    // Changes for anyone who had ever used ⌘E, which is everyone.
    // A fresh closure each render is fine: the hook holds it in a ref.
    () => {
      setPanelTab("pr");
      setPanelOpen(true);
    },
    // A merge or a reopen changes what the sidebar's mark should say, and that
    // mark comes from a different read with a two-minute freshness window — so
    // without this the row keeps its open-PR glyph until the window expires or
    // a turn ends.
    //
    // `refreshAfterWrite`, not `refresh`: the write can land after the reader
    // has filtered the mutated repo off screen, and a plain refresh only reads
    // what is visible then. See the hook.
    () => prMarks.refreshAfterWrite(),
  );
  // A draft counts: GitHub reports one as `OPEN` with `isDraft` set, and a
  // draft is still the point at which the work stops being about this turn.
  const openPrsHere = pullRequests.prs.filter((pr) => pr.state === "OPEN");
  const hasOpenPr = openPrsHere.length > 0;
  // Only where *every* open one is a draft. A session carrying a draft beside a
  // real PR has something asking to land, and the mark should say so.
  const allDrafts = hasOpenPr && openPrsHere.every((pr) => pr.isDraft);
  // The sidebar already knows whether this branch has a pull request, and the
  // panel's own read takes the better part of a second to agree — during which
  // `prs` is empty, the tab is not in the row, and a pane opened onto the PR tab
  // lands on Changes and jumps a beat later. So the mark stands in, but *only*
  // while that read is out: once it answers, the panel's own answer governs, so
  // this can never leave a tab drawn for a branch it found no PR on. The two
  // can disagree — the mark is looked up by the branch the index remembers and
  // the panel by the one git reports — and the window closes either way.
  const markHere = prMarks.prFor(selectedSession?.projectPath ?? "", prBranch);
  const hasPrTab =
    prTabVisible(pullRequests.prs, pullRequests.error) || (pullRequests.loading && !!markHere);

  // Where the pane lands with nothing picked. An open pull request wins over
  // anything the last turn did: changes describe one turn and are superseded by
  // the next, where a PR is the state of the work.
  const defaultTab: PanelTab = hasOpenPr && hasPrTab ? "pr" : "changes";

  // Read off the *pick*, not off `activeTab`, which is derived below from the
  // tab row this feeds. An unset pick does not count here, unlike the PR tab's:
  // the derived default is never the issue tab, so nothing is being read unless
  // the reader asked for it.
  const activeTabIsIssue = panelTab === "issue";

  // Straight off the index entry, which is where a link lives — so the tab is
  // there the moment a prompt tags one, with no read to wait on.
  const sessionIssues = selectedSession?.issues ?? [];
  const hasIssueTab = sessionIssues.length > 0;

  const issueData = useSessionIssues(sessionIssues, panelShown && activeTabIsIssue);

  // Read here rather than in the panel, for the PR tab's reason: the row has to
  // know whether the tab exists before that tab has ever been drawn.
  const { docs, activePath: activeDocPath, opened: docsOpened } = useDocs();
  const hasDocsTab = docs.length > 0;
  const activeDoc = docs.find((doc) => doc.path === activeDocPath) ?? null;

  const tabs = tabOrder({ pr: hasPrTab, docs: hasDocsTab, issue: hasIssueTab });

  // One rule, read rather than written back: an explicit pick wins wherever it
  // still names a tab this session draws, and otherwise the derived default
  // stands in. Not written back, so switching to a session without a PR keeps
  // the reader's pick for when they switch to one that has it.
  const activeTab: PanelTab = panelTab && tabs.includes(panelTab) ? panelTab : defaultTab;

  const togglePanel = () => setPanelOpen((prev) => !prev);

  // Moves along the visible row, wrapping. Off `tabs` rather than `PANEL_TABS`,
  // so a session with no PR tab cycles through two and never lands on one that
  // isn't drawn.
  const stepTab = (delta: number) => {
    if (!panelShown) return;
    const from = tabs.indexOf(activeTab);
    setPanelTab(tabs[(from + delta + tabs.length) % tabs.length]);
  };

  // Opens the tab without touching the selection, so a run the reader already
  // had expanded is still expanded when they come back to it.
  const openSubagentPanel = () => {
    setPanelTab("subagents");
    setPanelOpen(true);
  };

  const openSubagent = (id: string) => {
    setSelectedSubagentId(id);
    openSubagentPanel();
  };

  // An open session's own directory, since project- and local-scoped commands
  // differ per repo and a session can be running somewhere the picker isn't
  // pointed — a worktree, or a project switched away from since. The `@` picker
  // resolves against the same directory for the same reason, and off the same
  // expression so the two can't answer for different trees.
  const composerCwd = selectedSession?.cwd ?? projectPath;
  const slashCommands = useSlashCommands(composerCwd, harness);
  // `true` wherever Dray has no answer: the list may not have landed, and pi
  // picks its own model when none is named. A warning drawn on a guess is worse
  // than none, so absence reads as capable.
  const modelTakesImages =
    models.find((m) => m.id === modelId)?.acceptsImages ?? true;

  const { baseline, head } = useMemo(
    () => changeRange(selectedSession?.events ?? []),
    [selectedSession?.events],
  );

  // A pull request appears because something happened, and the thing that
  // happens is a turn — the agent running `gh pr create`, or the reader opening
  // one in a browser while a turn was in flight. Nothing else re-reads: the
  // panel's poll is gated on the PR tab being visible *and* active, and that tab
  // is hidden exactly while the answer is "no PR", so the one state that needed
  // rechecking was the only one that could never self-heal.
  //
  // The falling edge, not `!busy`, or an idle session re-asks on every unrelated
  // render — and the session id rides along because `busy` is the *selected*
  // session's: switching from a running session to an idle one drops it without
  // any turn having ended.
  const lastTurn = useRef({ sessionId: selectedSessionId, busy });
  useEffect(() => {
    const prev = lastTurn.current;
    lastTurn.current = { sessionId: selectedSessionId, busy };
    if (prev.sessionId !== selectedSessionId || !prev.busy || busy) return;
    pullRequests.refresh();
    prMarks.refresh();
  }, [selectedSessionId, busy, pullRequests.refresh, prMarks.refresh]);

  // From the sidebar's own per-repo read, not a fourth git call: once a pull
  // request exists the panel is where it is acted on, and a Create PR button
  // beside it would open a duplicate.
  //
  // An *open* one, and the check is explicit now that the marks carry merged
  // ones too: a branch whose PR has landed and is being worked on again wants
  // Create PR back. Nothing else usually offers it there — a merged branch is
  // level with its base, which `handoff` reads as nothing to open — but the two
  // answer different questions and folding them cost the button in the one case
  // it was wanted.
  const sessionHasPr = markHere?.state === "OPEN";

  // Read off the two tree ids rather than off the panel's file list: the panel
  // pauses its reads while hidden, which is exactly when the indicator has to
  // be right.
  const lastTurnChanged = turnChangedTree({ baseline, head });

  // The click lands on whatever the glyph was drawing — a git icon that opened
  // the subagents tab would be a lie. That is all this does now: which tab the
  // pane *defaults* to is `activeTab`'s rule and needs no help here, and ⌘E
  // stays a plain toggle because it draws nothing and so promises nothing.
  const handleTogglePanel = () => {
    // On the issues page the chord only ever *closes*. There is nothing for it
    // to reopen — a row is what picks an issue — so a toggle that could open
    // would have to guess which one, and the last pick is rarely the one wanted
    // on the way back. Closing is the half that has an unambiguous meaning.
    if (issuesOpen) return setPickedIssue(null);
    if (!panelOpen) {
      if (hasOpenPr && hasPrTab) setPanelTab("pr");
      else if (lastTurnChanged) setPanelTab("changes");
    }
    togglePanel();
  };

  // What tells the panel to re-read — a cache key, not a count. The event total
  // moves as a turn's writes land, and `busy` covers the turn ending, where the
  // final file write and the closing event can arrive in either order.
  const revision = `${selectedSession?.events.length ?? 0}:${busy}`;

  // Both panel bodies are presentational, and their hooks live here for the
  // same reason: the tab row needs what they know before either tab is opened —
  // whether a PR tab exists at all, and which refresh the one shared button
  // should run.
  const changesData = useChanges(
    selectedSession?.cwd ?? "",
    baseline,
    head,
    revision,
    panelShown && activeTab === "changes",
  );

  // One button, so the tab decides what it re-reads. Subagents has nothing to
  // fetch, so it gets none rather than a button that does nothing.
  const panelRefresh =
    activeTab === "changes"
      ? { onRefresh: changesData.refresh, loading: changesData.loading }
      : activeTab === "pr"
        ? { onRefresh: pullRequests.refresh, loading: pullRequests.loading }
        : activeTab === "issue"
          ? { onRefresh: issueData.refresh, loading: issueData.loading }
          : activeTab === "docs"
            ? {
                onRefresh: refreshActiveDoc,
                loading: activeDoc?.body.status === "loading",
              }
            : null;

  // Same order the sidebar draws, so the walk matches the list even when the
  // sidebar is collapsed and there is nothing on screen to follow — project
  // list included, since that is what orders the groups it steps through.
  const ordered = useMemo(
    () =>
      sortSessions(
        searchedSessions,
        projects,
        // The same reading the sidebar groups by, and withheld on the same list
        // — the walk has to step the runs the eye is looking at.
        showArchived ? undefined : { statusBySession, asking: askingSessions },
      ),
    [searchedSessions, projects, showArchived, statusBySession, askingSessions],
  );

  // Wraps downward only. Falling off the bottom returns to the newest session,
  // which is where a walk through the whole list wants to end up; the top holds
  // instead, since arriving at the oldest session by pressing *up* past the
  // newest one reads as a mistake rather than as a wrap.
  const stepSession = (delta: number) => {
    if (ordered.length === 0) return;
    const from = ordered.findIndex((i) => i.sessionId === selectedSessionId);
    // No selection is the empty composer — either direction enters at the top.
    const next =
      from === -1
        ? 0
        : delta > 0
          ? (from + 1) % ordered.length
          : Math.max(from - 1, 0);
    const item = ordered[next];
    if (item.sessionId !== selectedSessionId) {
      void handleSelectSessionIndexItem(item.sessionId);
    }
  };

  // A click on a markdown path in the transcript, which is the one route in.
  // Off the counter rather than off `docs.length`, since reopening a file that
  // is already open leaves the list unchanged and still has to bring the pane
  // forward.
  //
  // The pick moves as well as the pane, and has to, for the same reason
  // `usePullRequest`'s `onOpened` writes one: `activeTab` honours a standing
  // pick over the derived default, and `handleTogglePanel` stores "changes"
  // every time the pane opens onto a turn that touched files.
  const lastOpened = useRef(docsOpened);
  useEffect(() => {
    if (docsOpened === lastOpened.current) return;
    lastOpened.current = docsOpened;
    setPanelTab("docs");
    setPanelOpen(true);
  }, [docsOpened, setPanelTab, setPanelOpen]);

  // The pane is one piece of app-wide state, so a new task would otherwise
  // inherit whichever pane the last session left open — invisibly, since the
  // empty composer draws none, and then mounted open the moment the first
  // prompt creates the session. That is the one moment its reads have nothing
  // to answer from: the repo isn't resolved yet, so the tab draws an error for
  // a second or three before the first read lands. Keyed on the selection
  // rather than on `handleNewSession`, so every route to the empty composer is
  // covered — ⌘N, the sidebar's +, settling the open session, deleting it.
  useEffect(() => {
    if (!selectedSessionId) setPanelOpen(false);
  }, [selectedSessionId]);

  // Every way of arriving at a session, so none of them can forget to leave the
  // issues page. The two sidebar buttons closed it and the chords beside them
  // did not, which made ⌘N and ⌘⇧↑/↓ look inert: they moved the selection under
  // a column still full of issues, and the change only showed up on the way
  // back. The page itself is left as it was — its filters and its scroll come
  // back with it — so this is a navigation, not a dismissal.
  const goToSession = (go: () => void) => {
    setIssuesOpen(false);
    go();
  };

  /// Leaves the issues page for the empty composer, with the issue tagged in
  /// the draft.
  ///
  /// The tag alone is the whole handoff: `expand_tags` resolves it out of the
  /// prompt text on send, so nothing is linked here. It lands in the composer
  /// rather than starting a session, which is what leaves the project, the
  /// model and the harness still to be picked.
  const workOnIssue = (issue: { identifier: string; title: string }) => {
    goToSession(handleNewSession);
    appendToDraft(null, issueTag(issue.identifier, issue.title));
  };

  /// Writes a session's settled or pinned flag and takes the sidebar wherever
  /// that write left the row.
  ///
  /// One function because there are two ways to unsettle — the sidebar row's
  /// menu and the composer's own bar — and they have to land in the same place.
  /// The bar reached `setSessionFlags` directly at first, which wrote the flag
  /// and nothing else: the row left the settled list it was drawn from, the
  /// view stayed settled, and the session the reader had just taken back was
  /// nowhere on screen.
  const handleSetSessionFlags = async (
    sessionId: string,
    flags: { archived?: boolean; pinned?: boolean },
  ) => {
    // Everything below describes a move the index has made. A failed write —
    // or one naming a session that is no longer there — has moved nothing, so
    // it gets no celebration, no worktree offer, and no navigation: the row is
    // still where it was, and `setSessionFlags` has already put the reason on
    // screen.
    if (!(await setSessionFlags(sessionId, flags))) return;

    if (flags.archived === true) {
      playCelebration();

      // Settling is the reader saying this work is done, which is the
      // one moment the worktree behind it is provably spare. Asked
      // after the flag write lands, so the question is about a task
      // that is already settled rather than a condition of settling it.
      const item = sessionIndexItems.find((i) => i.sessionId === sessionId);
      if (item?.worktreeName) {
        void askAboutWorktree(sessionId, item.worktreeName, item.title, "notice");
      }
    }
    // Settling the open session leaves nothing to look at but the
    // unsettle bar, so it goes back to the empty composer instead.
    if (flags.archived === true && sessionId === selectedSessionId) {
      goToSession(handleNewSession);
    } else if (flags.archived === false) {
      // The row has just left whichever list it was drawn from, so follow it to
      // the one it landed in and keep it selected — from the sidebar's menu the
      // reader pressed that row, and from the composer's bar they are reading
      // its transcript. Either way, losing it is losing the thing they acted on.
      //
      // Unconditional, and after the write. Unconditional because the guard it
      // replaces read `showArchived` from a closure captured before the await,
      // so a reader who opened the settled view while the write was in flight
      // was left in it with the row gone; setting a boolean to the value it
      // already holds costs nothing. After, because the flip is what triggers
      // the list refetch, and a refetch racing a write still in flight answers
      // from an index that has not moved yet.
      setShowArchived(false);
      goToSession(() => void handleSelectSessionIndexItem(sessionId));
    }
  };

  const toggleSidebar = () => setCollapsed((prev) => !prev);
  useHotkey("b", toggleSidebar);
  useHotkey("n", () => goToSession(handleNewSession));
  // Steps the composer's project picker, and only while that picker is on
  // screen: it is drawn for a new task alone, and `enabled` unregisters rather
  // than no-opping, so a session's composer doesn't have ⌘⇧P eaten from it.
  // Wraps, since one key with a clamp dead-ends on the last project with no way
  // back. Nothing picked yet finds no index and lands on the first, which is
  // also the answer for a project detached out from under the pick.
  useHotkey(
    "p",
    () => {
      const next = projects[(projects.findIndex((p) => p.path === projectPath) + 1) % projects.length];
      if (next) handleSelectProject(next.path);
    },
    { shift: true, enabled: !selectedSessionId && !issuesOpen && projects.length > 1 },
  );
  // ⌘⇧ rather than plain ⌘: the composer is focused most of the time, where
  // ⌘↑/↓ is the webview's own jump-to-start/end of the input.
  useHotkey("ArrowUp", () => goToSession(() => stepSession(-1)), { shift: true });
  useHotkey("ArrowDown", () => goToSession(() => stepSession(1)), { shift: true });
  // ⌘E for the right pane against ⌘B for the left.
  //
  // Bound to the raw toggle rather than to `handleTogglePanel`, deliberately:
  // that one picks a tab on the way open, which is right for a button the
  // reader aimed at and wrong for a chord that draws nothing and so promises
  // nothing. Which means the issues-page guard has to be repeated here — it
  // lived only in `handleTogglePanel` at first, so the button honoured it and
  // the chord went straight past it to a pane that is not on screen.
  useHotkey("e", () => {
    if (issuesOpen) return setPickedIssue(null);
    togglePanel();
  });
  // ⌘⇧[ / ⌘⇧] — the browser and editor chord for stepping through tabs, so it
  // arrives already known. The shift layout reaches `key`, so the character is
  // `{` rather than `[`; the physical key rides along for the engines that
  // report the unshifted one — see `code`.
  useHotkey("{", () => stepTab(-1), { shift: true, code: "BracketLeft" });
  useHotkey("}", () => stepTab(1), { shift: true, code: "BracketRight" });
  // ⌘R re-reads whatever the panel is showing — the same one button in the tab
  // row, so the chord means "refresh this" and never "refresh a specific
  // thing". `panelRefresh` is null on Subagents, which has nothing to fetch,
  // and the pane being closed is a no-op: refreshing something invisible is
  // work with no way to see it land, and both panel hooks pause their reads
  // there anyway.
  //
  // Safe to take despite being the webview's reload, because `useHotkey` claims
  // every chord it matches — and the app has no Reload menu item, which on
  // macOS would swallow the key before the webview ever saw it.
  useHotkey("r", () => {
    // "Re-read what I am looking at", the same rule the session case follows:
    // the pane wins where one is open, and the list has it otherwise.
    if (issuesOpen) {
      if (pickedIssue) return pickedIssueData.refresh();
      return issuesRefreshRef.current?.();
    }
    if (panelShown) panelRefresh?.onRefresh();
  });
  // ⌘S writes the doc on screen. Unregistered rather than a no-op off that tab:
  // `useHotkey` claims every chord it matches, and ⌘S is the browser's own save
  // — left bound everywhere it would eat the key from nothing at all.
  useHotkey("s", saveActiveDoc, { enabled: panelShown && activeTab === "docs" });
  // By position in the tab row, so a third view needs only a third line here.
  // No-ops without a session, where there is no row to switch — and on the
  // issues page, where the row is not drawn: switching an invisible tab looks
  // like nothing happening and then shows up as the wrong view on the way back.
  useHotkey("1", () => !issuesOpen && setViewTab("chat"));
  useHotkey("2", () => !issuesOpen && setViewTab("changes"));
  // ⌘, — every macOS app's preferences chord, and the only way into settings
  // while the sidebar is collapsed and its gear gone with it. Safe to take for
  // `useHotkey`'s usual pair of reasons: it claims the chord, and the app's
  // custom menu carries no Settings item to swallow the key first.
  useHotkey(",", () => setSettingsOpen(true));
  // Both only mean anything before a session exists — the agent *is* the child
  // process and the worktree is where it starts — so they are unregistered
  // rather than no-ops there. `useHotkey` claims every chord it matches, and
  // ⌘⇧T is reopen-closed-tab in a webview: left bound on a session that cannot
  // use it, it would eat the key and do nothing.
  const composingNewSession = !selectedSessionId && !issuesOpen;
  // Steps the picker's own row in its own order, rather than toggling between
  // two — a toggle written when there were two silently never reached pi.
  useHotkey("a", () => setHarness(nextHarness(harness)), {
    shift: true,
    enabled: composingNewSession,
  });
  useHotkey("t", () => setUseWorktree((v) => !v), {
    shift: true,
    // A worktree has nothing to fork from until a project is picked, which is
    // the same condition the toggle itself is drawn under.
    enabled: composingNewSession && projectPath !== null,
  });
  // No accelerator: Shift+Tab on its own, and the model gets it because the
  // model is the pick reached for most often. The CLI spends this chord on
  // permission mode, which in practice gets set once and left.
  //
  // Cycles rather than opening the picker, which is what makes it worth a
  // chord at all: a menu that then wants arrows and Enter is three keys to do
  // what the trigger does in one click. Sane only because the cycle is short —
  // two models on Claude Code, three on Codex — so a wrong landing is one more
  // press away from right. Leaves each model's own remembered effort alone,
  // same as picking it from the menu.
  //
  // `cycledModels` is the picker's own top-level list, and sharing it is what
  // keeps the chord honest: it must never land on a model the menu doesn't
  // draw. That is bounded by `secondary` on the written lists and by the
  // reader's stars on pi's discovered one — where cycling the full list
  // walked every model every logged-in provider serves.
  //
  // A session already on a model outside the list enters the cycle at its
  // start, the same convention `nextEffort` takes for a level it doesn't
  // cycle.
  useHotkey(
    "Tab",
    () => {
      const cycle = cycledModels(models, harness, modelId);
      if (cycle.length < 2) return;
      const index = cycle.findIndex((m) => m.id === modelId);
      const next = cycle[(index + 1) % cycle.length];
      handleModelChange(next.id, null);
    },
    { meta: false, shift: true },
  );
  // ⌘⇧E for effort, beside ⌘E for the right pane — near enough to remember and
  // no collision, since `useHotkey` matches Shift exactly and neither listener
  // answers the other's chord. No `code`: that option is for a chord whose
  // character *changes* under Shift, and Shift+E is still an E — the matcher
  // lowercases both sides.
  useHotkey(
    "e",
    () => {
      const next = nextEffort(models.find((m) => m.id === modelId), effort);
      if (next) handleModelChange(modelId, next);
    },
    { shift: true },
  );
  // Opens, and does nothing where the page is already up — the same answer the
  // sidebar row gives, since that is the only other route in. Not a toggle:
  // nothing on that page opens the pane either (⌘E closes only there), and a
  // chord that closed it would have to pick somewhere to land, which is the
  // guess `goToSession` exists so nothing has to make.
  useHotkey("i", () => setIssuesOpen(true));
  const fullscreen = useFullscreen();
  useGlass(fullscreen);

  return (
    <TooltipProvider>
    <DiffWorkerPool pair={codeThemePair}>
    <AppShell
      // The issues page fills the column, so the centred empty-composer state
      // is wrong there even with no session selected.
      centered={!selectedSession && !issuesOpen}
      sidebar={
        <Sidebar
          items={searchedSessions}
          search={search}
          onSearchChange={setSearch}
          projects={projects}
          projectFilter={projectFilter}
          onProjectFilterChange={setProjectFilter}
          statusBySession={statusBySession}
          askingSessions={askingSessions}
          prFor={prMarks.prFor}
          // Cleared while the page is up. The column is showing issues, so a
          // lit row would name a session that is nowhere on screen — and the
          // selection itself is kept, which is what makes coming back free.
          selectedSessionId={issuesOpen ? null : selectedSessionId}
          collapsed={collapsed}
          onToggleCollapsed={toggleSidebar}
          onOpenSettings={() => setSettingsOpen(true)}
          onSelect={(sessionId) =>
            goToSession(() => void handleSelectSessionIndexItem(sessionId))
          }
          onNewSession={() => goToSession(handleNewSession)}
          onNewSessionInProject={(path) =>
            goToSession(() => {
              handleSelectProject(path);
              handleNewSession();
            })
          }
          onOpenIssues={() => setIssuesOpen(true)}
          issuesOpen={issuesOpen}
          onDetach={detachSession}
          onSetFlags={handleSetSessionFlags}
          onFork={forkSession}
          onDelete={deleteSession}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived((v) => !v)}
          updateStatus={updateStatus}
          updateBlocked={anyRunning}
          updateManual={updateManual}
          onInstallUpdate={() => void installUpdate()}
        />
      }
      header={
        <header
          className="flex h-(--titlebar-h) shrink-0 items-center gap-2 px-3"
          // `deep`, not bare: bare drags only on direct hits, so every label
          // inside this row was a dead strip in a titlebar that looks uniform.
          // Buttons still block on their own — Tauri stops walking up at any
          // clickable element that carries no attribute of its own.
          data-tauri-drag-region="deep"
        >
          {/* Only when collapsed — expanded, the sidebar owns the toggle. This
              header reaches the window edge in that state, so it has to clear
              the traffic lights, which fullscreen removes. */}
          {collapsed && (
            <div
              className={cn(
                "flex items-center",
                // Fullscreen has no traffic lights, so the toggle pulls back past
                // the header's own padding to sit flush at the window edge.
                fullscreen ? "-ml-1" : "pl-(--traffic-lights-w)",
              )}
            >
              {/* No dev badge beside it: the badge lives at the sidebar's
                  bottom edge now and shows nothing while the sidebar is
                  collapsed, the same bargain `UpdateRow` makes — neither is
                  urgent enough to earn a second home in this header. */}
              <SidebarToggle onToggle={toggleSidebar} collapsed />
            </div>
          )}

          <SessionHeader
            session={selectedSession}
            branch={prBranch}
            standIn={issuesOpen ? "Issues" : null}
            className="flex-1"
          />

          {!issuesOpen && selectedSession && <ViewTabs tab={viewTab} onChange={setViewTab} />}

          {issuesOpen
            ? // Only once something is open to close. Nothing on this page can
              // *open* the pane — a row does that — so a toggle drawn at rest
              // would be a control with one dead state.
              pickedIssue && (
                <PanelToggle onToggle={() => setPickedIssue(null)} open changes={false} />
              )
            : selectedSession && (
                <PanelToggle
                  onToggle={handleTogglePanel}
                  open={panelOpen}
                  changes={lastTurnChanged}
                  pr={hasOpenPr && hasPrTab}
                  draft={allDrafts}
                />
              )}
        </header>
      }
      panel={
        // The pane describes whatever the main column is showing. On the issues
        // page that is an issue and never a session — which is the whole reason
        // the session's pane is hidden there: left up, it went on describing
        // changes and a pull request belonging to work the reader had left.
        issuesOpen ? (
          <RightPanel
            open={!!pickedIssue}
            // A word rather than a tab row: there is one thing in this pane
            // and nothing to switch to. "Details" and not "Issue", which would
            // name the tab this replaced and say the same thing as the pane's
            // own contents.
            heading="Details"
            tab="issue"
            onTabChange={() => {}}
            refresh={{
              onRefresh: pickedIssueData.refresh,
              loading: pickedIssueData.loading,
            }}
            // In the strip rather than on the issue's own row, beside Refresh:
            // it acts on the issue the pane is showing, which is the pane's
            // whole subject — the same slot Open takes for a session.
            actions={
              pickedIssue && (
                <Button variant="secondary" size="xs" onClick={() => workOnIssue(pickedIssue)}>
                  Work on it
                  <Plus data-icon="inline-end" />
                </Button>
              )
            }
          >
            <TabBody active>
              <IssuePanel
                // No session, so no link to remove — the row draws its open-in-
                // tracker button and nothing else.
                sessionId={null}
                issues={pickedIssueRefs}
                onUnlink={() => {}}
                details={pickedIssueData.details}
                loading={pickedIssueData.loading}
                unavailable={pickedIssueData.unavailable}
              />
            </TabBody>
          </RightPanel>
        ) : // Mounted whenever a session is, open or not — closing or switching
        // tabs only hides, so reopening shows what was already there instead of
        // refetching and re-highlighting it. `active` is what stops the hidden
        // changes tab from snapshotting the working tree in the background.
        selectedSession ? (
          <RightPanel
            open={panelShown}
            tab={activeTab}
            onTabChange={setPanelTab}
            counts={{
              subagents: subagents.length,
              pr: prBadgeCount(pullRequests.prs),
              // Only above one: a tab reading "Issue 1" says what the tab
              // already says, and the count is news exactly when there is more
              // than one thing behind it.
              issue: sessionIssues.length > 1 ? sessionIssues.length : 0,
              // Same rule, and beside it so the rule reads once: the count is
              // news exactly when there is more than one file behind the tab.
              docs: docs.length > 1 ? docs.length : 0,
            }}
            pr={hasPrTab}
            docs={hasDocsTab}
            issue={hasIssueTab}
            refresh={panelRefresh}
            cwd={selectedSession.cwd}
          >
            <TabBody active={activeTab === "changes"}>
              <ChangesPanel cwd={selectedSession.cwd} baseline={baseline} {...changesData} />
            </TabBody>
            <TabBody active={activeTab === "subagents"}>
              <SubagentPanel
                runs={subagents}
                selectedId={selectedSubagentId}
                resultByCallId={resultByCallId}
                live={busy || backgroundTasks.length > 0}
                onSelect={setSelectedSubagentId}
                onStopTask={handleStopTask}
              />
            </TabBody>
            <TabBody active={hasPrTab && activeTab === "pr"}>
              <PrPanel branch={prBranch} {...pullRequests} />
            </TabBody>
            <TabBody active={hasDocsTab && activeTab === "docs"}>
              <DocsPanel />
            </TabBody>
            <TabBody active={hasIssueTab && activeTab === "issue"}>
              <IssuePanel
                sessionId={selectedSessionId}
                issues={sessionIssues}
                onUnlink={unlinkIssue}
                {...issueData}
              />
            </TabBody>
          </RightPanel>
        ) : null
      }
      footer={
        // Only under the transcript it writes into. The other views are not
        // conversations, and a composer under them would send into a session
        // the reader can't see. Safe to unmount: the draft and the attachment
        // tray are module-level stores precisely because the composer already
        // unmounts crossing the empty state.
        issuesOpen || (selectedSession && viewTab !== "chat") ? null : (
        <ChatInput
          onSend={handleSendMsg}
          commands={slashCommands}
          cwd={composerCwd}
          onStop={handleInterrupt}
          onCancelQueued={handleCancelQueued}
          onCancelRecording={() => {
            if (recorder.state !== "recording") return false;
            void recorder.cancel();
            return true;
          }}
          dictating={recorder.state !== "idle"}
          dictation={
            <DictateControl
              state={recorder.state}
              level={recorder.level}
              savedAudio={recorder.savedAudio}
              onStart={() => void recorder.start()}
              onStop={() => void recorder.stop()}
              onCancel={() => void recorder.cancel()}
              onRetry={() => void recorder.retry()}
              // Reveals rather than opens: the reader asking for the file wants
              // to keep it, play it, or send it on, and Finder is the one place
              // all three are reachable. Same reasoning `pickFileOpener` gives.
              onReveal={() =>
                recorder.savedAudio && void revealItemInDir(recorder.savedAudio)
              }
            />
          }
          queuedCount={queuedMessages.length}
          busy={busy}
          sessionId={selectedSessionId}
          isNewTask={!selectedSession}
          issuesConnected={issuesConnected}
          modelTakesImages={modelTakesImages}
          error={error}
          onDismissError={() => setError(null)}
          archived={selectedSession?.archived ?? false}
          onUnarchive={() =>
            selectedSessionId &&
            void handleSetSessionFlags(selectedSessionId, { archived: false })
          }
          onRemoveWorktree={
            selectedSessionId && selectedSession?.worktreeName
              ? () =>
                  void askAboutWorktree(
                    selectedSessionId,
                    selectedSession.worktreeName as string,
                    selectedSession.title,
                    "dialog",
                  )
              : undefined
          }
          handoff={
            <HandoffRow
              actions={handoffActions(workStatus, sessionHasPr, !!selectedSessionId)}
              // Straight out as a prompt, exactly as if it had been typed. A
              // turn already running queues it, like any other send.
              onSend={(prompt) => void handleSendMsg(prompt)}
              disabled={!selectedSessionId}
            />
          }
          // Only on a new task. An agent is fixed at creation, so a live
          // session cannot be pointed at one that is missing — and a session
          // that already exists has a CLI that already ran.
          notice={
            !selectedSessionId && missingAgent ? (
              <AgentMissingNotice agent={missingAgent} />
            ) : loggedOutAgent && authTurn && selectedSession ? (
              <LoginExpiredNotice
                agent={loggedOutAgent}
                cwd={selectedSession.cwd}
                onHandled={() => setLoginHandled(authTurn)}
              />
            ) : null
          }
          toolbar={
            <ComposerToolbar
              harness={harness}
              onHarnessChange={setHarness}
              models={models}
              modelId={modelId}
              effort={effort}
              onModelChange={handleModelChange}
              onRefreshModels={refreshModels}
              loadingModels={loadingModels}
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
              projects={projects}
              projectPath={projectPath}
              onSelectProject={handleSelectProject}
              onAttachProject={handleAttachProject}
              branches={branches}
              branch={branch}
              onSelectBranch={handleSelectBranch}
              pendingBranch={pendingBranch}
              onConfirmBranchSwitch={(stash) =>
                pendingBranch && runCheckout(pendingBranch, stash)
              }
              onCancelBranchSwitch={() => setPendingBranch(null)}
              useWorktree={useWorktree}
              onToggleWorktree={() => setUseWorktree((v) => !v)}
              onAttach={() => void pickAttachments(selectedSessionId)}
              contextUsage={contextUsage}
              isNewSession={!selectedSessionId}
            />
          }
        />
        )
      }
    >
      {/* Hidden rather than unmounted, like everything else in this column:
          the list, its filters and its scroll survive a trip into a session and
          back, which is the trip this page exists to make. */}
      <TabBody active={issuesOpen}>
        <IssuesView
          active={issuesOpen}
          picked={pickedIssue?.identifier ?? null}
          onPick={setPickedIssue}
          onWorkOn={workOnIssue}
          refreshRef={issuesRefreshRef}
          connected={issuesConnected}
          onConnect={integrations.connect}
          connecting={integrations.busy}
          connectError={integrations.error}
        />
      </TabBody>

      {/* Hidden rather than unmounted, the same bargain the right panel's tabs
          make: the transcript keeps its scroll position and its highlighted
          diffs, and the repo view keeps its selection and its reads. */}
      <TabBody active={!issuesOpen && viewTab === "chat"}>
      <Chat
        session={selectedSession}
        streamingBlock={
          selectedSessionId ? streamingContentBlock[selectedSessionId] ?? null : null
        }
        onOpenSubagent={openSubagent}
        onOpenSession={(id) => void handleSelectSessionIndexItem(id)}
        onOpenSubagentPanel={openSubagentPanel}
        onRespondPermission={handleRespondPermission}
        onAnswerQuestions={handleAnswerQuestions}
        busy={busy}
        backgroundTaskCount={backgroundTasks.length}
        liveTaskIds={liveTaskIds}
        compacting={compacting}
        apiRetry={apiRetry}
        queuedMessages={queuedMessages}
        working={working}
        crowded={!collapsed && (panelShown || (issuesOpen && !!pickedIssue))}
        active={!issuesOpen && viewTab === "chat"}
      />
      </TabBody>

      {selectedSession && (
        // Keyed by session so the selection, the sub-tab and the commit box
        // reset with it. Cheap to remount: the reads behind it are cached by
        // tree id at module level and survive the unmount.
        <TabBody active={!issuesOpen && viewTab === "changes"}>
          <ChangesView
            key={selectedSession.sessionId}
            cwd={selectedSession.cwd}
            active={viewTab === "changes"}
            revision={revision}
          />
        </TabBody>
      )}
    </AppShell>
    {/* Outside `AppShell` on purpose: it is fixed to the window rather than
        placed in the layout, and the shell has no slot that isn't a pane. */}
    <NoticeStack
      onSelect={(id) => goToSession(() => void handleSelectSessionIndexItem(id))}
      // The session and the pane both, since the card is about something the
      // transcript does not show. The pick is written the same way
      // `usePullRequest`'s `onOpened` writes it — `activeTab` honours a
      // standing pick, and opening the pane stores "changes" on its own.
      onOpenPr={(id) => {
        void handleSelectSessionIndexItem(id);
        setPanelTab("pr");
        setPanelOpen(true);
      }}
      onDeleteWorktree={(id) => removeWorktree(id)}
    />
    <QuitDialog />
    {/* Mounted here rather than in the sidebar, which unmounts whole when it
        collapses and would take ⌘, with it. */}
    <SettingsDialog
      open={settingsOpen}
      onOpenChange={(next) => {
        setSettingsOpen(next);
        if (!next) setSettingsTab("appearance");
      }}
      initialTab={settingsTab}
      integrations={integrations}
      updateStatus={updateStatus}
      updateManual={updateManual}
      updateBlocked={anyRunning}
      onCheckUpdates={checkForUpdates}
      onInstallUpdate={installUpdate}
      updateChannel={updateChannel}
      onUpdateChannelChange={setUpdateChannel}
    />
    <WorktreeDialog
      prompt={worktreePrompt}
      onConfirm={(sessionId) => removeWorktree(sessionId)}
      onClose={() => setWorktreePrompt(null)}
    />
    </DiffWorkerPool>
    </TooltipProvider>
  );
}

export default App;
