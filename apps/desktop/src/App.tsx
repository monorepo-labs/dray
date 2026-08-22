import { useEffect, useMemo, useState } from "react";

import "./App.css";
import Chat from "@/components/Chat";
import ChangesPanel from "@/components/ChangesPanel";
import ChangesView from "@/components/changes/ChangesView";
import ChatInput from "@/components/ChatInput";
import DiffWorkerPool from "@/components/DiffWorkerPool";
import NoticeStack from "@/components/NoticeStack";
import QuitDialog from "@/components/QuitDialog";
import PrPanel from "@/components/PrPanel";
import { useChanges } from "@/hooks/useChanges";
import { prTabVisible, usePullRequest } from "@/hooks/usePullRequest";
import RightPanel, { PanelToggle, TabBody, type PanelTab } from "@/components/RightPanel";
import Sidebar, { DevBadge, SidebarToggle, sortSessions } from "@/components/Sidebar";
import SubagentPanel from "@/components/SubagentPanel";
import ComposerToolbar from "@/components/composer/ComposerToolbar";
import { nextPermissionMode } from "@/components/composer/PermissionSelector";
import AppShell from "@/components/layout/AppShell";
import SessionHeader from "@/components/layout/SessionHeader";
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
import { useSessions } from "@/hooks/useSessions";
import { useSlashCommands } from "@/hooks/useSlashCommands";
import { useUpdater } from "@/hooks/useUpdater";
import { changeRange, turnChangedTree } from "@/lib/changes";
import { prBadgeCount, sessionBranch } from "@/lib/pr";
import { playCelebration } from "@/lib/sound";
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
  const [panelTab, setPanelTab] = useLocalStorage<PanelTab>("ade.panelTab", "changes");
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);

  // Per session, and deliberately not persisted the way `panelTab` is: which
  // view you were last on is working context for one session rather than a
  // standing preference, and reopening the app onto a repo view for every
  // session would be wrong more often than right.
  const [viewTabs, setViewTabs] = useState<Record<string, ViewTab>>({});
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
  // `panelTab` and not `activeTab`, which cannot exist yet — it is derived from
  // this hook's own answer. Harmless: the only case the two disagree is a tab
  // that isn't drawn, which means no PRs, which means nothing to poll for.
  const pullRequests = usePullRequest(
    selectedSession?.cwd ?? "",
    prBranch,
    panelOpen && panelTab === "pr",
  );
  const hasOpenPr = pullRequests.prs.some((pr) => pr.state === "OPEN");
  const hasPrTab = prTabVisible(pullRequests.prs, pullRequests.error);

  // The stored tab outlives the session it was chosen in, so it can name one
  // this session doesn't have. Resolved on read rather than written back:
  // switching to a session without a PR must not forget that the PR tab is
  // where the reader was, for when they switch to one that has it.
  const activeTab: PanelTab = panelTab === "pr" && !hasPrTab ? "changes" : panelTab;

  const togglePanel = () => setPanelOpen((prev) => !prev);

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

  // Read off the two tree ids rather than off the panel's file list: the panel
  // pauses its reads while hidden, which is exactly when the indicator has to
  // be right.
  const lastTurnChanged = turnChangedTree({ baseline, head });

  // The toggle's own click lands on what its glyph promised — a git icon that
  // opened the subagents tab would be a lie. ⌘E stays a plain toggle: it shows
  // nothing, so it promises nothing.
  const handleTogglePanel = () => {
    if (!panelOpen) {
      // Same precedence the glyph draws with, so the tab that opens is the one
      // the button was showing.
      if (hasOpenPr && hasPrTab) setPanelTab("pr");
      // Remembered tabs are restored, with one exception: a PR tab holding
      // nothing but merged or closed work is a record, and opening the pane
      // onto a record is not what the reader reached for. Only on open — the
      // tab stays clickable, so it can still be read on purpose.
      else if (lastTurnChanged || panelTab === "pr") setPanelTab("changes");
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
  // By position in the tab row, so a third view needs only a third line here.
  // No-ops without a session, where there is no row to switch.
  useHotkey("1", () => setViewTab("chat"));
  useHotkey("2", () => setViewTab("changes"));
  // No accelerator: Shift+Tab on its own, matching the CLI's own chord for this.
  useHotkey("Tab", () => setPermissionMode(nextPermissionMode(permissionMode)), {
    meta: false,
    shift: true,
  });
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
          selectedSessionId={selectedSessionId}
          collapsed={collapsed}
          onToggleCollapsed={toggleSidebar}
          onSelect={handleSelectSessionIndexItem}
          onNewSession={handleNewSession}
          onSetFlags={async (sessionId, flags) => {
            await setSessionFlags(sessionId, flags);
            if (flags.archived === true) {
              playCelebration();
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
            prFirst={hasOpenPr}
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
    <NoticeStack onSelect={(id) => void handleSelectSessionIndexItem(id)} />
    <QuitDialog />
    </DiffWorkerPool>
    </TooltipProvider>
  );
}

export default App;
