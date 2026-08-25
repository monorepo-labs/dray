import { useEffect, useMemo, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import "./App.css";
import Chat from "@/components/Chat";
import ChangesPanel from "@/components/ChangesPanel";
import ChangesView from "@/components/changes/ChangesView";
import ChatInput from "@/components/ChatInput";
import DiffWorkerPool from "@/components/DiffWorkerPool";
import NoticeStack from "@/components/NoticeStack";
import QuitDialog from "@/components/QuitDialog";
import WorktreeDialog, { type WorktreePrompt } from "@/components/WorktreeDialog";
import PrPanel from "@/components/PrPanel";
import { useChanges } from "@/hooks/useChanges";
import { usePrMarks } from "@/hooks/usePrMarks";
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
import Sidebar, { DevBadge, SidebarToggle, sortSessions } from "@/components/Sidebar";
import SubagentPanel from "@/components/SubagentPanel";
import ComposerToolbar from "@/components/composer/ComposerToolbar";
import AppShell from "@/components/layout/AppShell";
import SessionHeader from "@/components/layout/SessionHeader";
import { nextEffort } from "@/components/composer/ModelSelector";
import ViewTabs, { type ViewTab } from "@/components/layout/ViewTabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { pickAttachments } from "@/hooks/useAttachments";
import { useCodeTheme } from "@/hooks/useCodeTheme";
import { useDoubleTap } from "@/hooks/useDoubleTap";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useVibrancy } from "@/hooks/useVibrancy";
import { warmHighlighter } from "@/hooks/useHighlighter";
import { useHotkey } from "@/hooks/useHotkey";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { pushNotice } from "@/hooks/useNotices";
import { useSessions } from "@/hooks/useSessions";
import type { WorktreeDisposition } from "@/types/events";
import { useSlashCommands } from "@/hooks/useSlashCommands";
import { useUpdater } from "@/hooks/useUpdater";
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
    compacting,
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
    deleteSession,
    removeWorktree,
  } = useSessions();

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
  } = useUpdater();

  // Every session the app has started this run, not the open one: the install
  // relaunches the app, so any live child is one this would kill mid-turn. A
  // session from a previous run cannot still be running — no child survives a
  // restart — so the live map answers this on its own.
  const anyRunning = Object.values(statusBySession).some((s) => s === "in_progress");

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

  const [worktreePrompt, setWorktreePrompt] = useState<WorktreePrompt | null>(null);

  // Reads what the removal would cost *before* deciding whether to ask, so a
  // worktree that isn't there any more — deleted by hand, or by a `claude` run
  // that had an exit prompt of its own — is tidied up silently. Asking about a
  // directory the reader can no longer see is a question with one answer.
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
      void removeWorktree(sessionId);
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
    // Same `busy` the chat passes. Left off, a subagent's in-flight call would
    // show in the panel as one that never finished.
    () => buildTranscript(selectedSession?.events ?? [], busy),
    [selectedSession?.events, busy],
  );

  // Read here rather than inside the panel: the tab row needs to know whether
  // there is an open PR before that tab has ever been shown, so ordering it
  // first can't wait on the panel fetching for itself.
  const prBranch = selectedSession ? sessionBranch(selectedSession) : null;
  // The sidebar's own read is set up further down — it depends on the visible
  // session list — so the panel reaches it through a ref rather than the two
  // being reordered around each other.
  const prMarksRef = useRef<(() => void) | null>(null);
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
    panelOpen && (panelTab === "pr" || panelTab === null),
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
    () => prMarksRef.current?.(),
  );
  // A draft counts: GitHub reports one as `OPEN` with `isDraft` set, and a
  // draft is still the point at which the work stops being about this turn.
  const openPrsHere = pullRequests.prs.filter((pr) => pr.state === "OPEN");
  const hasOpenPr = openPrsHere.length > 0;
  // Only where *every* open one is a draft. A session carrying a draft beside a
  // real PR has something asking to land, and the mark should say so.
  const allDrafts = hasOpenPr && openPrsHere.every((pr) => pr.isDraft);
  const hasPrTab = prTabVisible(pullRequests.prs, pullRequests.error);

  // Where the pane lands with nothing picked. An open pull request wins over
  // anything the last turn did: changes describe one turn and are superseded by
  // the next, where a PR is the state of the work.
  const defaultTab: PanelTab = hasOpenPr && hasPrTab ? "pr" : "changes";

  const tabs = tabOrder({ pr: hasPrTab });

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
    if (!panelOpen) return;
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
  const slashCommands = useSlashCommands(composerCwd);

  const { baseline, head } = useMemo(
    () => changeRange(selectedSession?.events ?? []),
    [selectedSession?.events],
  );

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
  prMarksRef.current = prMarks.refresh;

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

  // What the composer's handoff row draws itself from. Read on the same falling
  // edge as the pull requests above, since a turn is what moves all of it.
  const { status: workStatus, refresh: refreshWorkStatus } = useWorkStatus(
    selectedSession?.cwd ?? "",
    busy,
  );
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
  const sessionHasPr =
    !!selectedSession &&
    prMarks.prFor(selectedSession.projectPath, prBranch)?.state === "OPEN";

  // The one handoff action that runs rather than asks. It reports into no
  // transcript, so both ends are its own: the flag the button spins on, and the
  // error banner above the composer — the same one every other backend failure
  // reaches the reader through.
  const [pushing, setPushing] = useState(false);
  const push = async () => {
    if (pushing || !selectedSession) return;
    setPushing(true);
    try {
      await invoke("push_branch", { cwd: selectedSession.cwd });
      // Straight away rather than on the next turn's edge: the count on the
      // button is now wrong, and it is the thing the reader is looking at.
      refreshWorkStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setPushing(false);
    }
  };

  // Read off the two tree ids rather than off the panel's file list: the panel
  // pauses its reads while hidden, which is exactly when the indicator has to
  // be right.
  const lastTurnChanged = turnChangedTree({ baseline, head });

  // The click lands on whatever the glyph was drawing — a git icon that opened
  // the subagents tab would be a lie. That is all this does now: which tab the
  // pane *defaults* to is `activeTab`'s rule and needs no help here, and ⌘E
  // stays a plain toggle because it draws nothing and so promises nothing.
  const handleTogglePanel = () => {
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
    panelOpen && activeTab === "changes",
  );

  // One button, so the tab decides what it re-reads. Subagents has nothing to
  // fetch, so it gets none rather than a button that does nothing.
  const panelRefresh =
    activeTab === "changes"
      ? { onRefresh: changesData.refresh, loading: changesData.loading }
      : activeTab === "pr"
        ? { onRefresh: pullRequests.refresh, loading: pullRequests.loading }
        : null;

  // Same order the sidebar draws, so the walk matches the list even when the
  // sidebar is collapsed and there is nothing on screen to follow.
  const ordered = useMemo(() => sortSessions(visibleSessions), [visibleSessions]);

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

  const toggleSidebar = () => setCollapsed((prev) => !prev);
  useHotkey("b", toggleSidebar);
  useHotkey("n", handleNewSession);
  // ⌘⇧ rather than plain ⌘: the composer is focused most of the time, where
  // ⌘↑/↓ is the webview's own jump-to-start/end of the input.
  useHotkey("ArrowUp", () => stepSession(-1), { shift: true });
  useHotkey("ArrowDown", () => stepSession(1), { shift: true });
  // ⌘E for the right pane against ⌘B for the left.
  useHotkey("e", togglePanel);
  // ⌘⇧[ / ⌘⇧] — the browser and editor chord for stepping through tabs, so it
  // arrives already known. The shift layout reaches `key`, so the character is
  // `{` rather than `[`; the physical key rides along for the engines that
  // report the unshifted one — see `code`.
  useHotkey("{", () => stepTab(-1), { shift: true, code: "BracketLeft" });
  useHotkey("}", () => stepTab(1), { shift: true, code: "BracketRight" });
  // By position in the tab row, so a third view needs only a third line here.
  // No-ops without a session, where there is no row to switch.
  useHotkey("1", () => setViewTab("chat"));
  useHotkey("2", () => setViewTab("changes"));
  // No accelerator: Shift+Tab on its own. The CLI spends this chord on
  // permission mode, which in practice gets set once and left; effort is the
  // dial actually reached for mid-work, so it takes the cheapest key here.
  useHotkey(
    "Tab",
    () => {
      const next = nextEffort(models.find((m) => m.id === modelId), effort);
      if (next) handleModelChange(modelId, next);
    },
    { meta: false, shift: true },
  );
  // Double-tap Shift cycles the model, JetBrains-search style — leaves each
  // model's own remembered effort alone, same as picking it from the menu.
  useDoubleTap("Shift", () => {
    if (models.length < 2) return;
    const index = models.findIndex((m) => m.id === modelId);
    const next = models[(index + 1) % models.length];
    handleModelChange(next.id, null);
  });
  const fullscreen = useFullscreen();
  useVibrancy(fullscreen);

  return (
    <TooltipProvider>
    <DiffWorkerPool pair={codeThemePair}>
    <AppShell
      centered={!selectedSession}
      sidebar={
        <Sidebar
          items={visibleSessions}
          projects={projects}
          projectFilter={projectFilter}
          onProjectFilterChange={setProjectFilter}
          statusBySession={statusBySession}
          askingSessions={askingSessions}
          prFor={prMarks.prFor}
          selectedSessionId={selectedSessionId}
          collapsed={collapsed}
          onToggleCollapsed={toggleSidebar}
          onSelect={handleSelectSessionIndexItem}
          onNewSession={handleNewSession}
          onSetFlags={async (sessionId, flags) => {
            await setSessionFlags(sessionId, flags);
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
              handleNewSession();
            } else if (flags.archived === false) {
              // Unsettling only happens from the settled list, and the row
              // just left it — follow it back to where it landed, onto the
              // row itself.
              if (showArchived) setShowArchived(false);
              void handleSelectSessionIndexItem(sessionId);
            }
          }}
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
              <SidebarToggle onToggle={toggleSidebar} collapsed />
              {import.meta.env.DEV && <DevBadge className="ml-1" />}
            </div>
          )}

          <SessionHeader session={selectedSession} className="flex-1" />

          {selectedSession && <ViewTabs tab={viewTab} onChange={setViewTab} />}

          {selectedSession && (
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
        // Mounted whenever a session is, open or not — closing or switching
        // tabs only hides, so reopening shows what was already there instead of
        // refetching and re-highlighting it. `active` is what stops the hidden
        // changes tab from snapshotting the working tree in the background.
        selectedSession ? (
          <RightPanel
            open={panelOpen}
            tab={activeTab}
            onTabChange={setPanelTab}
            counts={{ subagents: subagents.length, pr: prBadgeCount(pullRequests.prs) }}
            pr={hasPrTab}
            refresh={panelRefresh}
          >
            <TabBody active={activeTab === "changes"}>
              <ChangesPanel cwd={selectedSession.cwd} baseline={baseline} {...changesData} />
            </TabBody>
            <TabBody active={activeTab === "subagents"}>
              <SubagentPanel
                runs={subagents}
                selectedId={selectedSubagentId}
                resultByCallId={resultByCallId}
                live={busy}
                onSelect={setSelectedSubagentId}
                onStopTask={handleStopTask}
              />
            </TabBody>
            <TabBody active={hasPrTab && activeTab === "pr"}>
              <PrPanel branch={prBranch} {...pullRequests} />
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
        selectedSession && viewTab !== "chat" ? null : (
        <ChatInput
          onSend={handleSendMsg}
          commands={slashCommands}
          cwd={composerCwd}
          onStop={handleInterrupt}
          onCancelQueued={handleCancelQueued}
          queuedCount={queuedMessages.length}
          busy={busy}
          sessionId={selectedSessionId}
          isNewTask={!selectedSession}
          error={error}
          onDismissError={() => setError(null)}
          archived={selectedSession?.archived ?? false}
          onUnarchive={() =>
            selectedSessionId && setSessionFlags(selectedSessionId, { archived: false })
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
              actions={handoffActions(workStatus, sessionHasPr)}
              // Straight out as a prompt, exactly as if it had been typed. A
              // turn already running queues it, like any other send.
              onSend={(prompt) => void handleSendMsg(prompt)}
              onPush={() => void push()}
              pushing={pushing}
              disabled={!selectedSessionId}
            />
          }
          toolbar={
            <ComposerToolbar
              models={models}
              modelId={modelId}
              effort={effort}
              onModelChange={handleModelChange}
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
      {/* Hidden rather than unmounted, the same bargain the right panel's tabs
          make: the transcript keeps its scroll position and its highlighted
          diffs, and the repo view keeps its selection and its reads. */}
      <TabBody active={viewTab === "chat"}>
      <Chat
        session={selectedSession}
        streamingBlock={
          selectedSessionId ? streamingContentBlock[selectedSessionId] ?? null : null
        }
        onOpenSubagent={openSubagent}
        onOpenSubagentPanel={openSubagentPanel}
        onRespondPermission={handleRespondPermission}
        onAnswerQuestions={handleAnswerQuestions}
        busy={busy}
        backgroundTaskCount={backgroundTasks.length}
        compacting={compacting}
        queuedMessages={queuedMessages}
        working={working}
        crowded={!collapsed && panelOpen}
        active={viewTab === "chat"}
      />
      </TabBody>

      {selectedSession && (
        // Keyed by session so the selection, the sub-tab and the commit box
        // reset with it. Cheap to remount: the reads behind it are cached by
        // tree id at module level and survive the unmount.
        <TabBody active={viewTab === "changes"}>
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
      onSelect={(id) => void handleSelectSessionIndexItem(id)}
      onDeleteWorktree={(id) => removeWorktree(id)}
    />
    <QuitDialog />
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
