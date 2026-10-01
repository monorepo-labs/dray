import { lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

import "./App.css";
import Chat from "@/components/Chat";
import ChatInput from "@/components/ChatInput";
import DiffWorkerPool from "@/components/DiffWorkerPool";
import NoticeStack from "@/components/NoticeStack";
import LinkDialog from "@/components/chat/LinkDialog";
import QuitDialog from "@/components/QuitDialog";
import type { SettingsTab } from "@/components/SettingsPage";
import WorktreeDialog, { type WorktreePrompt } from "@/components/WorktreeDialog";
import MorePanel from "@/components/MorePanel";
import PlanPanel from "@/components/PlanPanel";

// Nothing here is on first paint, so each is its own chunk, fetched the first
// time its view opens (`MountOnce`) rather than parsed on every launch.
const ChangesPanel = lazy(() => import("@/components/ChangesPanel"));
const ChangesView = lazy(() => import("@/components/changes/ChangesView"));
const FilesView = lazy(() => import("@/components/files/FilesView"));
const DocsPanel = lazy(() => import("@/components/DocsPanel"));
const SettingsPage = lazy(() => import("@/components/SettingsPage"));
const IssuePanel = lazy(() => import("@/components/IssuePanel"));
const IssuesView = lazy(() => import("@/components/IssuesView"));
const PrPanel = lazy(() => import("@/components/PrPanel"));
const BrowserPane = lazy(() => import("@/components/browser/BrowserPane"));
import {
  clearOpenError,
  closeTab,
  describePick,
  isRecording,
  navigate,
  openInBrowser,
  setPendingTab,
  setPickHandler,
  useBrowserTabs,
  usePendingTab,
} from "@/lib/browser";
import { setLinkOpener } from "@/lib/openLink";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useChanges } from "@/hooks/useChanges";
import { usePrMarks } from "@/hooks/usePrMarks";
import { usePrReady } from "@/hooks/usePrReady";
import { useWorkStatus } from "@/hooks/useWorkStatus";
import HandoffRow from "@/components/composer/HandoffRow";
import { trackFeature } from "@/lib/analytics";
import { handoffActions } from "@/lib/handoff";
import { prTabVisible, usePullRequest } from "@/hooks/usePullRequest";
import RightPanel, {
  MountOnce,
  PANEL_MIN,
  PanelToggle,
  TabBody,
  tabOrder,
  type PanelSide,
  type PanelTab,
} from "@/components/RightPanel";
import {
  CHAT_MIN,
  useChatColumnFloor,
  usePaneWidth,
  useViewportWidth,
} from "@/components/ResizeHandle";
import Sidebar, {
  SIDEBAR_MIN,
  SEARCH_INPUT_ID,
  SidebarToggle,
  filterSessions,
  sessionUnits,
  sortSessions,
} from "@/components/Sidebar";
import Crew, { CREW_STACK_WITH_PANEL_W, CREW_W } from "@/components/Crew";
import SplitView, { DragGhost, DropZone, type PaneChat } from "@/components/SplitView";
import { DROP_ATTR, useSessionDrag, type DropTarget } from "@/lib/dragSession";
import {
  closePane,
  dropLabel,
  EMPTY_VIEW,
  GROUPS_KEY,
  groupName,
  members,
  groupOf,
  openBeside,
  paneOrder,
  pruneGroups,
  type SplitGroup,
} from "@/lib/groups";
import ComposerToolbar from "@/components/composer/ComposerToolbar";
import DictateControl from "@/components/composer/DictateControl";
import AppShell from "@/components/layout/AppShell";
import SessionHeader from "@/components/layout/SessionHeader";
import { offersFast } from "@/lib/fastMode";
import {
  filterFor,
  linearWorkspaces,
  projectForPath,
  workspaceFor,
  workspaceName,
} from "@/lib/linearWorkspace";
import { lockedMidTurn } from "@/lib/liveControls";
import { nextEffort } from "@/components/composer/ModelSelector";
import { nextHarness } from "@/lib/model";
import { cycledModels } from "@/lib/starredModels";
import ViewTabs, { type ViewTab } from "@/components/layout/ViewTabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { pickAttachments } from "@/hooks/useAttachments";
import { useCodeTheme } from "@/hooks/useCodeTheme";
import { refreshActiveDoc, saveActiveDoc, useDocs } from "@/hooks/useDocs";
import { closeFile, useOpenFiles } from "@/hooks/useOpenFiles";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useGlass } from "@/hooks/useGlass";
import { warmHighlighter } from "@/hooks/useHighlighter";
import { setHotkeysSuspended, useHotkey } from "@/hooks/useHotkey";
import { stepZoom } from "@/lib/zoom";
import { cycleTheme } from "@/hooks/useTheme";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { dismissNotice, getNotices, pushNotice } from "@/hooks/useNotices";
import { useIntegrations } from "@/hooks/useIntegrations";
import { useSessionIssues } from "@/hooks/useIssues";
import { useSessions } from "@/hooks/useSessions";
import { useAgentAvailability, useMissingAgent } from "@/hooks/useAgentAvailability";
import AgentMissingNotice from "@/components/composer/AgentMissingNotice";
import AgentUpdateLine from "@/components/composer/AgentUpdateLine";
import { useAgentUpdates } from "@/hooks/useAgentUpdates";
import LoginExpiredNotice from "@/components/composer/LoginExpiredNotice";
import type { IssueRef, SessionIndexItem, WorktreeDisposition } from "@/types/events";
import { useSlashCommands } from "@/hooks/useSlashCommands";
import { useRecorder } from "@/hooks/useTranscription";
import { useUpdater } from "@/hooks/useUpdater";
import { appendToDraft, readDraft, useHasDraft, writeDraft } from "@/hooks/useDraft";
import { issueTag, rememberIssueTitle, setIssueOpener } from "@/lib/issue";
import { authFailedTurn } from "@/lib/auth";
import { basename } from "@/lib/format";
import { focusComposer, focusComposerEnd } from "@/lib/composerFocus";
import { changeRange, lastToolResult, turnChangedTree } from "@/lib/changes";
import { usePlan } from "@/lib/plan";
import { currentTodos, startsNewList, type Todo } from "@/lib/todos";
import { prBadgeCount, sessionBranch } from "@/lib/pr";
import { crewAnchor, crewRows, crewSeen, inSidebar, withHiddenAsks } from "@/lib/crew";
import { panelMove, sidebarMove } from "@/lib/sidebarAuto";
import { playCelebration } from "@/lib/sound";
import {
  activeSpace,
  allowedInSpace,
  inSpace,
  moveSpace,
  sessionInSpace,
  spaceNames,
  SPACE_KEY,
  SPACE_LIST_KEY,
} from "@/lib/space";
import { worktreeNoticeDetail } from "@/lib/worktree";
import { useEnabledAgents } from "@/hooks/useEnabledAgents";
import { buildTranscript } from "@/lib/transcript";
import { cn } from "@/lib/utils";

const PANE_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/// One empty set, so clearing the rail's open rows twice is one state change.
const NO_ROWS: ReadonlySet<string> = new Set();

function App() {
  const {
    selectedSessionId,
    selectedSession,
    sessions,
    sessionIndexItems,
    statusBySession,
    askingSessions,
    archivedShown,
    archivedRequested,
    setShowArchived,
    models,
    refreshModels,
    reloadModels,
    seedFxModels,
    loadingModels,
    harness,
    setHarness,
    modelId,
    effort,
    fast,
    setFast,
    fastNote,
    permissionMode,
    projects,
    projectPath,
    branches,
    branch,
    useWorktree,
    busy,
    backgroundTasks,
    liveTaskIds,
    contextUsage,
    error,
    setError,
    handleModelChange,
    setPermissionMode,
    handleAttachProject,
    handleSelectProject,
    handleRemoveProject,
    setProjectSpace,
    setProjectLinearWorkspace,
    setProjectLinearFilter,
    reloadProjects,
    moveProject,
    retagSpace,
    canAnnounce,
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
    navGen,
    handleNewSession,
    markSessionUnread,
    setSessionFlags,
    forkSession,
    unlinkIssue,
    detachSession,
    deleteSession,
    removeWorktree,
    ensureLoaded,
    setOnScreen,
    setCrewSeen,
    paneState,
    indexSide,
  } = useSessions();

  // Whether the agent the composer is pointed at can actually be run. Null
  // while the first read is out and null when it is installed — both mean
  // there is nothing to say, so the composer sends as it always did.
  const missingAgent = useMissingAgent(harness);
  // Held on a new task for every agent, so the session starts on the new
  // version. A live session only for pi and fx, whose update overwrites files
  // its child reads; the other three install beside the running binary.
  // Keyed on the running update alone, never on the update list, which a
  // check landing mid-update may already have cleared.
  const agentUpdates = useAgentUpdates();
  const agentLabel = useAgentAvailability()?.find((a) => a.harness === harness)?.label ?? harness;
  const sendHeld =
    agentUpdates.running === harness &&
    (!selectedSessionId || harness === "pi" || harness === "fx")
      ? `Updating ${agentLabel}. Send once it finishes.`
      : null;
  // A new CLI version can ship new models, and every list but Claude's table is
  // cached for the life of the process.
  const updatedHarness = agentUpdates.done;
  useEffect(() => {
    if (updatedHarness) refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on a landed update alone
  }, [updatedHarness]);

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
  // The Browser view takes the sidebar with it and gives it back on the way
  // out. On by default, since a page is the one view whose content is somebody
  // else's and wants every pixel. Owned here rather than in the settings row
  // that draws it: `useLocalStorage` is per component, so a second copy there
  // would write a value this effect never reads.
  const [autoHideSidebar, setAutoHideSidebar] = useLocalStorage(
    "ade.autoHideSidebarInBrowser",
    true,
  );
  // The right pane's half of the same bargain, its own switch since a reader
  // may want the pane beside a page where the sidebar is only in the way.
  const [autoHidePanel, setAutoHidePanel] = useLocalStorage("ade.autoHidePanelInBrowser", true);
  // Owned here for the same reason: `RightPanel`, the shell and the settings
  // row all read it.
  const [panelSide, setPanelSide] = useLocalStorage<PanelSide>("ade.panelSide", "right");
  // Whether the reader has been told the app does that. Written once and never
  // cleared, the same bargain `splitLearned` makes below.
  const [autoHideNoticed, setAutoHideNoticed] = useLocalStorage(
    "ade.autoHideSidebarNoticed",
    false,
  );
  // The sidebar's scope, not the composer's: `projectPath` decides where a new
  // session runs, and switching what you're *looking at* must not quietly move
  // where the next prompt would land.
  const [projectFilter, setProjectFilter] = useLocalStorage<string | null>(
    "ade.projectFilter",
    null,
  );
  // The wider scope the filter sits inside: a space is a tag on a project, so
  // this narrows the project list itself and everything reading it follows.
  // Stored under the key `announce` reads, since notifications answer to the
  // same scope and there is only one right answer to which space is up.
  const [storedSpace, setStoredSpace] = useLocalStorage<string | null>(SPACE_KEY, null);
  // Spaces the reader has made but not yet filled. Membership is the tag on the
  // project, so this list only has to carry the ones no project names yet —
  // `spaceNames` reads the two as one set.
  const [declaredSpaces, setDeclaredSpaces] = useLocalStorage<string[]>(
    SPACE_LIST_KEY,
    [],
  );
  const spaces = useMemo(
    () => spaceNames(projects, declaredSpaces),
    [projects, declaredSpaces],
  );
  // Derived rather than corrected in place: a space that was removed takes its
  // stored name with it, and rewriting that from a render would be a write
  // nobody asked for.
  const space = activeSpace(projects, storedSpace, declaredSpaces);
  const spaceProjects = useMemo(() => inSpace(projects, space), [projects, space]);
  const {
    status: updateStatus,
    manual: updateManual,
    install: installUpdate,
    checkNow: checkForUpdates,
    channel: updateChannel,
    setChannel: setUpdateChannel,
  } = useUpdater();

  // Every session the app has started this run, not the open one: the install
  // relaunches the app, so any live child is one this would kill mid-turn. A
  // session from a previous run cannot still be running — no child survives a
  // restart — so the live map answers this on its own.
  //
  // The turn alone, never outstanding background tasks: a `local_bash` task
  // never ends, so a session running a dev server blocked the update for the
  // rest of its life with nothing saying why. Same reading Stop and fork take.
  const anyRunning = Object.values(statusBySession).some((s) => s === "in_progress");

  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);

  // Per session and not persisted: which view you were last on is working
  // context for one session rather than a standing preference, and reopening
  // the app onto a repo view for every session would be wrong more often than
  // right.
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
  /// Kept as a whole row rather than an identifier: the list already read every
  /// field a header draws, so the pane can be complete before its own detail
  /// read lands — the same bargain the session panel makes with a session's
  /// links. A *link* rather than an `Issue`, since a tag clicked in a prompt
  /// carries one of those and nothing more, and every field this holds for is
  /// on it.
  const [pickedIssue, setPickedIssue] = useState<IssueRef | null>(null);

  const viewTab: ViewTab = selectedSessionId ? viewTabs[selectedSessionId] ?? "chat" : "chat";

  /// The picked issue as the one-element list the panel reads.
  ///
  /// Memoized because it is an array: a fresh one each render would re-run the
  /// detail read on every keystroke in the page's search box.
  const pickedIssueRefs = useMemo(() => (pickedIssue ? [pickedIssue] : []), [pickedIssue]);

  const pickedIssueData = useSessionIssues(pickedIssueRefs, issuesOpen && !!pickedIssue);

  // Owned here rather than by any one surface: the settings row, the issues
  // page's own connect form and the composer's placeholder all read it, and a
  // hook per surface is a second answer to "are we connected" free to disagree
  // with the first.
  const integrations = useIntegrations(true, reloadProjects);
  // Either one is enough to draw the page and open the picker: the two are
  // alternatives rather than halves of one connection, and a reader with only
  // `gh` signed in has issues to read.
  const issuesConnected = integrations.connected.linear || integrations.connected.github;

  // Not persisted: settings are opened to change something and closed again, so
  // reopening the app into them would be the app remembering the wrong half of
  // a session.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which tab the *next* open lands on. Reset to Appearance as settings close,
  // so a mic press that sent the reader to Transcription does not leave every
  // later ⌘, opening there too.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  // Whether that open should land with the new-space field already up. Same
  // reset as the tab, and for the same reason: it describes the way in, not the
  // dialog.
  const [namingSpace, setNamingSpace] = useState(false);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsTab("appearance");
    setNamingSpace(false);
  }, []);
  // Layout, not ordinary: the switch must be down before the page paints, or a
  // keystroke in that frame reaches a shell nobody can see.
  useLayoutEffect(() => setHotkeysSuspended(settingsOpen), [settingsOpen]);

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
  useHotkey("dictate", () => void recorder.toggle(), { platformOnly: true });

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

    // The disposition read above is an `await`, so this card can arrive in a
    // space the reader has moved to since settling the session — and it names
    // the session's own title. The dialog route above is deliberately not
    // guarded: the reader pressed a button and is owed its answer.
    if (!canAnnounce(sessionId)) return;

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
  // The space is the outer scope and the filter the inner one, both applied
  // here: this list is what the sidebar draws, what the chords walk and what
  // the PR marks and the ready notice are read from, so narrowing it once is
  // the whole of "another space is running, out of sight".
  const visibleSessions = useMemo(
    () =>
      sessionIndexItems.filter(
        (i) =>
          sessionInSpace(projects, space, i.projectPath) &&
          (!projectFilter || i.projectPath === projectFilter),
      ),
    [sessionIndexItems, projects, space, projectFilter],
  );

  // Split groups: frontend-only, filed under the space they were made in. A
  // member whose project has since left the space is not drawn, and a group
  // that leaves fewer than two is no group here. Not narrowed by the project
  // filter — the grid shows the whole group, and the sidebar's run narrows
  // itself to the rows it draws.
  const [groups, setGroups] = useLocalStorage<SplitGroup[]>(GROUPS_KEY, []);
  const spaceGroups = useMemo(() => {
    const shown = new Set(
      sessionIndexItems
        .filter((i) => sessionInSpace(projects, space, i.projectPath))
        .map((i) => i.sessionId),
    );
    return groups
      .filter((g) => g.space === space)
      .map((g) => ({
        ...g,
        columns: g.columns.map((c) => c.filter((id) => shown.has(id))).filter((c) => c.length),
      }))
      .filter((g) => members(g).length >= 2);
  }, [groups, space, projects, sessionIndexItems]);

  // A deleted or archived member leaves its group. Gated on the *loaded* list
  // being the live one — not on `showArchived`, which flips before the live
  // list lands, so a switch back from Settled would prune every group against
  // the archived list still on screen. `null` covers launch, where the index
  // is empty for a moment.
  useEffect(() => {
    if (indexSide !== false) return;
    const present = new Set(sessionIndexItems.map((i) => i.sessionId));
    setGroups((prev) => pruneGroups(prev, present));
  }, [sessionIndexItems, indexSide, setGroups]);

  // Whether the reader has ever made a group. Written once and never cleared:
  // the sidebar's drag tip retires on it, and a group dissolving later does
  // not make the drag un-learned.
  const [splitLearned, setSplitLearned] = useLocalStorage("ade.splitLearned", false);
  useEffect(() => {
    if (groups.length > 0 && !splitLearned) setSplitLearned(true);
  }, [groups, splitLearned, setSplitLearned]);

  // Selecting a member is what activates a group; the selected session is the
  // focused pane, so every control that serves one session keeps doing so.
  const activeGroup = groupOf(spaceGroups, selectedSessionId);
  // The pane's open flag and tab pick are held per session, like `viewTabs`
  // above and for the same reason: app-wide, a pane opened on one session's
  // PR sat blank beside the next session, which had none, and was gone again
  // on the way back. Not persisted, and a session never opened holds no entry,
  // which is also what keeps a new task from inheriting whichever pane the
  // last session left up — the reads there have nothing to answer from until
  // the first turn lands.
  //
  // The open flag alone is keyed by the *group* while the session sits in one.
  // The pane stands beside the whole grid, and the selected session is
  // whichever pane has focus, so a per-session flag snapped it open and shut
  // as focus moved between panes. Open is a question about the column's
  // layout; the tab is a question about the focused session's content, and
  // so stays with the session. The two keys hand state across: a group
  // forming takes the focused session's flag, and every write lands on both,
  // so a group dissolving leaves each session holding the last state it saw.
  //
  // The pick's `null` is "never picked", and it is the whole of the default-tab
  // rule: seeding `"changes"` would make a fresh session indistinguishable from
  // one where the reader chose Changes, so an open PR could never lead — see
  // `activeTab`.
  const [panelOpens, setPanelOpens] = useState<Record<string, boolean>>({});
  const [panelTabs, setPanelTabs] = useState<Record<string, PanelTab | null>>({});
  const openKey = useCallback(
    (id: string) => {
      const group = groupOf(spaceGroups, id);
      return group ? `group:${group.id}` : id;
    },
    [spaceGroups],
  );
  useEffect(() => {
    if (!activeGroup || !selectedSessionId) return;
    const key = `group:${activeGroup.id}`;
    setPanelOpens((prev) =>
      key in prev ? prev : { ...prev, [key]: prev[selectedSessionId] ?? false },
    );
  }, [activeGroup, selectedSessionId]);
  const panelTab = selectedSessionId ? (panelTabs[selectedSessionId] ?? null) : null;
  // Both take the session because one caller opens a session and its pane in
  // the same breath, before the selection has moved.
  const setPanelTab = useCallback(
    (tab: PanelTab | null, id = selectedSessionId) => {
      if (id) setPanelTabs((prev) => ({ ...prev, [id]: tab }));
    },
    [selectedSessionId],
  );

  const memberKey = activeGroup ? members(activeGroup).join("\n") : "";
  const paneColumns = useMemo(
    () =>
      (activeGroup?.columns ?? []).map((column) =>
        column.flatMap((id) => sessionIndexItems.find((i) => i.sessionId === id) ?? []),
      ),
    [activeGroup, sessionIndexItems],
  );

  // What the composer names as its target in a grid: the focused session's
  // title, with its project in front where the panes span projects and a
  // title alone could belong to either.
  const splitTarget = (() => {
    if (!activeGroup || !selectedSession) return null;
    const projects = new Set(paneColumns.flat().map((i) => i.projectPath));
    return projects.size > 1
      ? `${basename(selectedSession.projectPath)} / ${selectedSession.title}`
      : selectedSession.title;
  })();

  // The crew's anchor — the conversation whose sessions are listed — settled
  // during render off a ref rather than in an effect. An effect is a frame
  // behind, and this is a frame in which the crew is drawn against the session
  // the reader has just left: it appears, vanishes or lists somebody else's
  // children for one paint.
  //
  // **Only a move made from inside the crew keeps it up.** Clicking a row or
  // reaching into its transcript is navigation within an arrangement the
  // reader is standing in; the sidebar and ⌘⇧↑/↓ are them leaving it, and the
  // anchor surviving those made the sidebar look broken — selecting a crew
  // member from over there moved the composer while the main column went on
  // showing the parent, so the click read as having done nothing. So the ref
  // is cleared on any selection this app did not route through `focusSession`,
  // and `crewAnchor` then answers for the selected session alone.
  //
  // The flag is consumed by a selection *changing*, so it is only ever set for
  // a move that changes one — focusing the session already selected consumes
  // nothing and would leave it armed for whatever the reader did next, which
  // is a bare sidebar click reading as a move from inside the crew.
  const crewRef = useRef<string | null>(null);
  const keepCrewRef = useRef(false);
  const lastSelectedRef = useRef(selectedSessionId);
  // Leaving deliberately — ⌘-click — cannot be a ref write on its own: the row
  // it acts on is usually the selected one, so there is no selection change to
  // read the write on and nothing else in that render would move. This is what
  // makes the leaving cause the render that reads it.
  const [, crewMoved] = useState(0);
  if (lastSelectedRef.current !== selectedSessionId) {
    if (!keepCrewRef.current) crewRef.current = null;
    keepCrewRef.current = false;
    lastSelectedRef.current = selectedSessionId;
  }
  crewRef.current = crewAnchor(visibleSessions, selectedSessionId, crewRef.current);
  const crewAnchorId = crewRef.current;
  const crew = useMemo(
    () => crewRows(visibleSessions, crewAnchorId, { statusBySession, askingSessions }),
    [visibleSessions, crewAnchorId, statusBySession, askingSessions],
  );
  // Whether this conversation has a crew to draw at all, and whether the reader
  // wants it drawn. The second is ⌘⇧C and nothing else: no button, since a
  // permanent control in the titlebar would be chrome for a thing most
  // conversations never have. Stated cost — hidden, the column is reachable
  // only by somebody who remembers the chord.
  //
  // Kept per conversation and in memory, the shape `panelOpens` above takes
  // and for its reason: what the column *holds* differs from one conversation
  // to the next, so a reader who put away a fan-out of six has said nothing
  // about the next one. Keyed on the anchor, since that is whose crew it is.
  // Not persisted, so a conversation never opened holds no entry and the map
  // cannot outgrow the session list.
  //
  // Three readings of one thing, and the split matters. `crewUp` is the
  // *arrangement* — what the main column is drawing and what the composer is
  // pointed at — and it deliberately does not ask which view tab is on screen:
  // tab bodies hide rather than unmount, so a flip to Files with a row focused
  // would otherwise swap the hidden transcript for that row's and swap it back
  // on return, taking the scroll pin and the mounted turns with it both ways.
  // `crewDrawn` is the column itself, which is the reading every gate on being
  // *seen* takes.
  // A grouped *anchor* has no crew: its column is already several
  // conversations side by side, so there is nowhere for the list to go. The
  // question is asked of the anchor and never of the selection — a child that
  // happens to sit in a split group would otherwise swap the whole column for
  // that group the moment its row was clicked, which is the arrangement
  // leaving on the one gesture that is supposed to stay inside it.
  const crewExists = crew.length > 0 && !groupOf(spaceGroups, crewAnchorId);
  const crewAvailable = crewExists && !issuesOpen && viewTab === "chat";
  // **Beside the chat only where it fits, judged on minimums alone.** The
  // crew never gives width back, so on a narrow window it crushed the sidebar
  // to a sliver. Measured off the sidebar's *drawn* width this would chase
  // itself — the crew's floor is what clamps that width — so it reads the
  // floor. Where it does not fit it starts hidden and ⌘⇧C stacks it under the
  // transcript instead; an explicit toggle outranks the default either way.
  // The panel counts as the crew would leave it — under the anchor's key, see
  // `panelKey` below — since reading `panelOpen` itself would loop back here.
  // The sidebar counts at its drawn width, since the panel yields to it and a
  // widened sidebar would otherwise leave the panel a sliver; floored at its
  // minimum, because narrowing the window clamps that width under it.
  // Up to a 14" MacBook's width, an open panel stacks the crew even where the
  // minimums fit: all four at their floors reads as cramped, not as fitting.
  // That case still starts shown — it fits, it is only drawn somewhere else.
  const crewPanelOpen = !!(crewAnchorId && panelOpens[crewAnchorId]) && !issuesOpen;
  const sidebarW = Math.max(SIDEBAR_MIN, usePaneWidth("sidebar"));
  const viewportW = useViewportWidth();
  const crewFits =
    viewportW >=
    CHAT_MIN + CREW_W + (collapsed ? 0 : sidebarW) + (crewPanelOpen ? PANEL_MIN : 0);
  const crewBeside = crewFits && !(crewPanelOpen && viewportW <= CREW_STACK_WITH_PANEL_W);
  const [crewHiddenBy, setCrewHiddenBy] = useState<Record<string, boolean>>({});
  const crewHidden = !!crewAnchorId && (crewHiddenBy[crewAnchorId] ?? !crewFits);
  const crewUp = crewExists && !crewHidden;
  const crewDrawn = crewAvailable && !crewHidden;

  // **Whose preference the right pane follows.** A split group is one
  // arrangement and answers under the group's id; the crew is the same shape —
  // selecting a row moves the composer and not the arrangement — so it answers
  // under the anchor. Keyed on the row instead, clicking down a crew of six
  // opened and shut the pane row by row out of whatever each session last
  // remembered from being read on its own, which reads as the panel flickering
  // rather than as a preference being honoured. Reached from the sidebar or a
  // chord the crew is down and the session answers for itself again, which is
  // the same rule seen from the other side.
  const panelKey =
    crewUp && crewAnchorId ? crewAnchorId : selectedSessionId && openKey(selectedSessionId);
  // The bare session id stands in for a group key the seeding effect below has
  // not filled yet, or a session reads shut for the commit before it lands.
  // Not offered to the crew: its key is a plain session id already, so falling
  // through there would read the *row's* own flag — the very thing this is
  // keyed away from.
  const panelOpen = panelKey
    ? (panelOpens[panelKey] ??
      (!crewUp && selectedSessionId ? panelOpens[selectedSessionId] : undefined) ??
      false)
    : false;
  const setPanelOpen = useCallback(
    (open: boolean | ((prev: boolean) => boolean), id?: string | null) => {
      // A caller naming a session means that one — it is opening a session and
      // its pane in the same breath, before the selection has moved — where the
      // default is the arrangement already on screen.
      const key = id ? openKey(id) : panelKey;
      if (!key) return;
      setPanelOpens((prev) => {
        const next = typeof open === "function" ? open(prev[key] ?? false) : open;
        return id ? { ...prev, [key]: next, [id]: next } : { ...prev, [key]: next };
      });
    },
    [panelKey, openKey],
  );

  /// Opens the pane onto one tab. The pick moves as well as the pane opening:
  /// `activeTab` honours a standing pick over the derived default, so opening
  /// alone lands wherever the reader last left it.
  const showPanel = useCallback(
    (tab: PanelTab, id?: string | null) => {
      setPanelTab(tab, id ?? undefined);
      setPanelOpen(true, id);
    },
    [setPanelTab, setPanelOpen],
  );

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
  // One conversation keeps a readable floor whatever the panes beside it are
  // dragged to; a split holds several deliberately small ones, so the same
  // floor there would refuse the layout the reader asked for. The crew rides
  // on top of it because it is fixed-width and never gives any of it back.
  // What the main column is actually showing. With a crew up that is the
  // anchor, which `crewExists` has already established is in no group.
  const mainGroup = crewUp ? null : activeGroup;
  useChatColumnFloor(!mainGroup, crewDrawn && crewBeside ? CREW_W : 0);

  const toggleCrew = () => {
    if (crewAnchorId) setCrewHiddenBy((prev) => ({ ...prev, [crewAnchorId]: !crewHidden }));
  };

  // **The main column keeps drawing the anchor, whatever is selected.** That is
  // the whole difference between this and the split grid: selecting a crew row
  // moves the composer, the right panel and the header to that session while
  // the conversation the reader is orchestrating from stays where it was.
  // Drawing it in both places instead was the first shape and it made the crew
  // a slower way to switch sessions — the same transcript twice on one screen,
  // with the second copy taking the place of the thing it was spawned out of.
  const mainSessionId = (crewUp && crewAnchorId) || selectedSessionId;

  // The composer says where it sends whenever that is not the transcript
  // under it — a grid's focused pane, or a crew row. One box under several
  // conversations is one box that can send into the wrong one, so it says
  // which before anything is typed.
  const composerTarget =
    (mainGroup && splitTarget) ??
    (mainSessionId !== selectedSessionId ? selectedSession?.title ?? null : null);
  // Composing into the focused session, so every other transcript gives way.
  // The emptiness alone, never the text: every mounted transcript is below
  // this, and subscribing to the string would rerender them all per keystroke.
  const composing = useHasDraft(selectedSessionId);

  // What the reader opened, emptied when the crew moves to another
  // conversation: the set names sessions, so carrying it across would reopen a
  // row only if the same session appeared under both anchors — rare, and rarer
  // still to be what was wanted.
  const [crewOpen, setCrewOpen] = useState<ReadonlySet<string>>(NO_ROWS);
  useEffect(() => setCrewOpen(NO_ROWS), [crewAnchorId]);

  // Both halves of an open row need the log: a transcript obviously, and a card
  // because `buildTranscript` reads the request out of the session's own
  // events. Gated on the crew being *drawn* rather than on it having rows,
  // since being on screen is what read-marking promises and a crew behind the
  // Files view is not.
  const crewShown = (crewDrawn ? crew : [])
    .filter((row) => crewOpen.has(row.item.sessionId) || row.asking)
    .map((row) => row.item.sessionId)
    .join("\n");

  // Every pane loaded and held: eviction and read-marking treat the whole grid
  // as on screen. One effect for the grid and the crew together, since
  // `setOnScreen` takes the whole set rather than adding to it — two callers
  // would each wipe the other's. The anchor rides along because the main
  // column is drawing it while something else is selected, which is exactly
  // the state the eviction sweep would otherwise read as nobody looking.
  // The grid's members only where the grid is what the column draws — a crew
  // child that happens to sit in a split group is on screen as a strip, not as
  // that group.
  const onScreenKey = [mainGroup ? memberKey : "", crewShown, crewUp ? crewAnchorId : null]
    .filter(Boolean)
    .join("\n");
  useEffect(() => {
    const ids = [...new Set(onScreenKey.split("\n").filter(Boolean))];
    setOnScreen(ids);
    ids.forEach((id) => void ensureLoaded(id));
    // Both are rebuilt every render; the key is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScreenKey]);

  // Every row of a drawn crew, for `announce` alone — see `crewSeen`. Wider
  // than `crewShown` above on purpose: that one loads and read-marks, where
  // this one only answers whether a card would land in front of the reader,
  // which every strip does without being opened first.
  //
  // **A layout effect, which is the one place this differs from `setOnScreen`
  // above — and the difference is which way being wrong costs.** That set only
  // widens what is kept in memory; a stale reading here *suppresses* a notice,
  // so it has to be exact in both directions and neither of the ordinary two
  // is. An ordinary effect lands after paint, so a crew put away with the chord
  // or flipped behind another view tab would go on naming its rows for a frame,
  // and an ask arriving there would be silenced with nothing on screen to
  // silence it for. A render-time write is the opposite hole: React may
  // interrupt or throw a render away, leaving this describing a column that was
  // never committed. A layout effect runs inside the commit and before the
  // browser paints, so what it publishes is always what was committed and there
  // is no frame in which the reader and this ref disagree — an event listener
  // is a task and cannot land in the middle of one.
  const crewSeenKey = crewSeen(crew, crewDrawn).join("\n");
  useLayoutEffect(() => {
    setCrewSeen(crewSeenKey.split("\n").filter(Boolean));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crewSeenKey]);

  // Focusing a transcript is what points the composer at it, and it is separate
  // from opening one: reaching into a transcript to scroll or copy is not
  // asking it to shut, and a row can be answered from its card without being
  // read. The main column takes it too — with a crew up it is one transcript
  // among several and clicking into it has to mean what clicking into a row
  // means, or the way *back* to the conversation is the only move on screen
  // with no click behind it.
  // This is also the one route that keeps the anchor, which is what makes it
  // the crew's own way of moving the composer: everything else lands on
  // `handleSelectSessionIndexItem` bare and takes the crew down with it.
  const focusSession = (id: string) => {
    if (id !== selectedSessionId) keepCrewRef.current = true;
    void handleSelectSessionIndexItem(id);
  };

  // Expanding a row focuses it too — asking to read something is asking to
  // talk to it. Collapsing the focused one hands the composer back to the
  // conversation the crew belongs to; collapsing any other row moves nothing,
  // since that is tidying rather than navigation.
  const toggleCrewRow = (id: string) => {
    const opening = !crewOpen.has(id);
    setCrewOpen((prev) => {
      const next = new Set(prev);
      if (opening) next.add(id);
      else next.delete(id);
      return next;
    });
    if (opening) focusSession(id);
    else if (id === selectedSessionId && crewAnchorId) focusSession(crewAnchorId);
  };

  // Leaving the arrangement outright, rather than leaving it to the selection
  // change to clear the anchor. Both callers act on a row that is usually the
  // focused one — already selected — so there is no change coming to read the
  // write on, and the arrangement would simply stand. The bump is what causes
  // the render that reads it; it is skipped where no anchor is held, which is
  // every ordinary sidebar click.
  //
  // **Run on the move landing, never before it.** A sidebar row can be stale,
  // and a selection that resolves to nothing puts the reader back where they
  // were — so tearing down first left them on the session they had been
  // reading with the crew column gone from under it. It self-heals where that
  // session *is* the anchor, since `crewAnchor` with no hold asks whether the
  // selection spawned anything; it does not where they were reading a child,
  // which is the ordinary place to be standing when this happens.
  const leaveCrew = () => {
    keepCrewRef.current = false;
    if (!crewRef.current) return;
    crewRef.current = null;
    crewMoved((n) => n + 1);
  };

  // Selecting from outside the crew: the move first, the teardown only if it
  // landed. Resolving takes a microtask at most for a session already held —
  // which is every crew row and most sidebar rows — so the anchor still drops
  // in the same frame the reader clicked in.
  const selectAndLeaveCrew = async (id: string) => {
    if (await handleSelectSessionIndexItem(id)) leaveCrew();
  };

  // ⌘-click: the one way out of the arrangement from inside it. Collapsed on
  // the way out, or coming back would find a row already open for a session
  // just read whole.
  const openCrewRowInMain = (id: string) => {
    setCrewOpen((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    void selectAndLeaveCrew(id);
  };

  // The dropped session is the one just opened, so it takes the focus. Only
  // on a drop that opens something: selecting after a refused one would swap
  // the grid for that session's single view.
  const dropSession = ({ sessionId: anchor, region }: DropTarget, dropped: string) => {
    if (!dropLabel(spaceGroups, anchor, dropped, region)) return;
    // Nothing open, so the drop is the click: the session opens whole.
    if (anchor !== EMPTY_VIEW) setGroups((prev) => openBeside(prev, anchor, dropped, region, space));
    void handleSelectSessionIndexItem(dropped);
  };

  const closeSessionPane = (sessionId: string) => {
    setGroups((prev) => closePane(prev, sessionId));
    if (sessionId !== selectedSessionId || !activeGroup) return;
    const next = members(activeGroup).find((id) => id !== sessionId);
    if (next) void handleSelectSessionIndexItem(next);
  };

  // The single view's own drop zone; a grid's panes draw theirs. The empty
  // column is one too, drawn whole: the drop opens the session, so there is
  // no side to the zone.
  const drag = useSessionDrag();
  const singleDrop =
    drag?.over && !activeGroup && drag.over.sessionId === (selectedSessionId ?? EMPTY_VIEW)
      ? {
          region: selectedSessionId ? drag.over.region : ("center" as const),
          label: dropLabel(spaceGroups, drag.over.sessionId, drag.sessionId, drag.over.region),
        }
      : null;

  // The search narrows what is drawn, and only that — the sidebar's own row is
  // where it is typed, but the list it filters is this one, so the ⌘⇧↑/↓ walk
  // below steps exactly the rows on screen.
  //
  // Layered over `visibleSessions` rather than folded into it, deliberately: the
  // marks and the ready-to-merge notice read that list to decide what to watch,
  // and a session dropping out of it as a query is typed would stop its repo
  // being polled and make the notice forget a pull request was already ready.
  const [search, setSearch] = useState("");
  // Whether the sidebar's search row is drawn as a field. Up here rather than in
  // the sidebar, since ⌘F has to open it from a collapsed one, which is not
  // mounted at all.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchedSessions = useMemo(
    () => filterSessions(inSidebar(visibleSessions), search),
    [visibleSessions, search],
  );
  // A hidden session's card lights its parent's row, the only row it has.
  const sidebarAsking = useMemo(
    () => withHiddenAsks(sessionIndexItems, askingSessions),
    [sessionIndexItems, askingSessions],
  );

  // The sidebar's marks: one `gh` per repo on screen rather than one per row —
  // see `usePrMarks`. Distinct paths, and the *active* list's only: a settled
  // session is work the reader has already dealt with, so a repo that appears
  // nowhere but the archived list is one nobody is waiting to land. Marks
  // already fetched still draw over there, since the cache outlives this — what
  // is dropped is the spending, not the answer.
  const repoPaths = useMemo(
    () => (archivedShown ? [] : [...new Set(visibleSessions.map((i) => i.projectPath))]),
    [archivedShown, visibleSessions],
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
  // The header's way back from a hidden session, which has no sidebar row. The
  // loaded side first, else asked of the backend: with the sidebar on the other
  // side of the settled split the parent is not in the list, and still exists.
  const hiddenParentId = selectedSession?.hidden ? selectedSession.parentSessionId : null;
  const loadedParent = sessionIndexItems.find((i) => i.sessionId === hiddenParentId);
  const [fetchedParent, setFetchedParent] = useState<SessionIndexItem | null>(null);
  useEffect(() => {
    if (!hiddenParentId || loadedParent) return;
    let live = true;
    void invoke<SessionIndexItem | null>("session_index_item", { sessionId: hiddenParentId })
      .then((item) => live && setFetchedParent(item))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [hiddenParentId, loadedParent]);
  const hiddenParent =
    loadedParent ?? (fetchedParent?.sessionId === hiddenParentId ? fetchedParent : undefined);
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
    () => showPanel("pr"),
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
  const { docs, activePath: activeDocPath, opened: docsOpened } = useDocs(selectedSessionId);
  // The counter brings the view forward; the active path is what ⌘W closes.
  // Which files are open past that is the view's own business, where a doc's
  // tab row has to exist in the panel before the panel is drawn.
  const { opened: filesOpened, active: activeFile } = useOpenFiles(selectedSessionId);
  const hasDocsTab = docs.length > 0;
  // Read here for the PR tab's reason too: the row has to know the tab exists
  // before the panel draws it, and the card's "View plan" button opens it.
  const sessionPlan = usePlan(selectedSessionId);
  const hasPlanTab = sessionPlan !== null;

  // Read off the session's own log rather than tracked as it arrives, the
  // context ring's bargain: a reopened session shows the list it showed live.
  // Memoized because it walks every event and this renders on each delta.
  const sessionTodos = useMemo(
    () => currentTodos(selectedSession?.events ?? []),
    [selectedSession?.events],
  );

  // The panel opens itself on a task list the reader has not been shown, and on
  // nothing else.
  //
  // Two rules make that safe, and both are borrowed. **Signal is transition,
  // not state** — `readyTransitions`' rule: the first reading of a session is
  // recorded silently, so arriving at a session that already has a list does
  // not drag the pane open over a transcript the reader came to read. And the
  // transition has to be a *different list* rather than any change at all, or
  // `todo_write` firing on every tick would yank the pane several times a turn
  // — see `startsNewList`. Held rather than derived, since only the previous
  // reading can say which this is; per session, since each has its own.
  const seenTodosRef = useRef(
    new Map<string, { todos: Todo[] | null; olderBefore: number | null }>(),
  );
  useEffect(() => {
    // Waiting on the transcript, not just the id: `sessionTodos` reads an empty
    // event list as `null` while one loads, so seeding before it lands would
    // record "no list" and then read the real one as news.
    if (!selectedSession) return;
    const { sessionId, olderBefore } = selectedSession;
    const seen = seenTodosRef.current;
    const previous = seen.get(sessionId);
    seen.set(sessionId, { todos: sessionTodos, olderBefore });
    // A page of older turns landing is history arriving, not a list being
    // written, so it re-seeds silently like the first reading does.
    if (previous === undefined || previous.olderBefore !== olderBefore) return;
    if (sessionTodos && startsNewList(previous.todos, sessionTodos)) showPanel("more");
  }, [selectedSession, sessionTodos]);

  const activeDoc = docs.find((doc) => doc.path === activeDocPath) ?? null;

  const browserTabs = useBrowserTabs(selectedSessionId);
  const pendingBrowserTab = usePendingTab(selectedSessionId ?? "");
  const hasBrowserTabs = browserTabs && browserTabs.length > 0;
  // The main column's Browser view is the panel's browser expanded. Arriving
  // on it closes the pane, whatever tab the pane was on: the reader came for
  // the full width. ⌘E brings it back beside the page, and leaving gives back
  // a pane the arrival took — the sidebar's rule, under its own switch.
  const fullBrowserOpen = !issuesOpen && viewTab === "browser";
  const lastViewTab = useRef(viewTab);
  // Set only where arriving on the browser is what collapsed the sidebar, so
  // leaving never reopens one the reader had closed themselves. `toggleSidebar`
  // drops the claim for the same reason: a sidebar they closed by hand while
  // reading a page is theirs, not ours to give back.
  const hidForBrowser = useRef(false);
  // The pane's claims, one per pane key, since the pane is per session — see
  // [panelMove](./lib/sidebarAuto.ts) for why one claim was not enough.
  const panelHidForBrowser = useRef(new Set<string>());
  const lastPanelKey = useRef(panelKey);
  useEffect(() => {
    const was = lastViewTab.current;
    lastViewTab.current = viewTab;
    const keyMoved = lastPanelKey.current !== panelKey;
    lastPanelKey.current = panelKey;

    if (panelKey) {
      const move = panelMove({
        from: was,
        to: viewTab,
        keyMoved,
        enabled: autoHidePanel,
        open: panelOpen,
        claimed: panelHidForBrowser.current.has(panelKey),
      });
      if (move === "hide") panelHidForBrowser.current.add(panelKey);
      else if (move === "restore") panelHidForBrowser.current.delete(panelKey);
      if (move) setPanelOpen(move === "restore");
    }

    // The sidebar's own rule is [sidebarMove](./lib/sidebarAuto.ts), which is
    // pure and tested: `collapsed` is a dep this effect only *reads*, so the
    // rule runs again on the frame it collapses the sidebar, and getting that
    // re-entry wrong handed the sidebar straight back.
    const move = sidebarMove({
      from: was,
      to: viewTab,
      enabled: autoHideSidebar,
      collapsed,
      claimed: hidForBrowser.current,
    });
    if (move === "hide") {
      hidForBrowser.current = true;
      setCollapsed(true);
      // Said once ever, and only where the sidebar actually moved: chrome that
      // rearranges itself with nothing to explain it reads as a bug.
      if (!autoHideNoticed) {
        setAutoHideNoticed(true);
        pushNotice({
          sessionId: "sidebar",
          kind: "sidebar-auto",
          label: "Sidebar hidden",
          detail: "The browser gets the full width. Turn this off in Settings → Appearance.",
        });
      }
    } else if (move === "restore") {
      hidForBrowser.current = false;
      setCollapsed(false);
    }
  }, [
    viewTab,
    setPanelOpen,
    panelOpen,
    panelKey,
    autoHidePanel,
    collapsed,
    setCollapsed,
    autoHideSidebar,
    autoHideNoticed,
    setAutoHideNoticed,
  ]);
  const expandBrowser = () => setViewTab("browser");
  const collapseBrowser = () => {
    setViewTab("chat");
    showPanel("browser");
  };

  // A live background task counts even where no run is built for it yet, and a
  // task list counts on its own — the tab is a catch-all, so any one of its
  // sections having something is enough to draw it.
  const hasMoreTab =
    subagents.length > 0 || backgroundTasks.length > 0 || sessionTodos !== null;

  const tabs = tabOrder({
    pr: hasPrTab,
    docs: hasDocsTab,
    issue: hasIssueTab,
    more: hasMoreTab,
    plan: hasPlanTab,
  });

  // One rule, read rather than written back: an explicit pick wins wherever it
  // still names a tab this session draws, and otherwise the derived default
  // stands in. Not written back, so switching to a session without a PR keeps
  // the reader's pick for when they switch to one that has it.
  const activeTab: PanelTab = panelTab && tabs.includes(panelTab) ? panelTab : defaultTab;

  // Drops the Browser view's claim, `toggleSidebar`'s reason: a pane moved by
  // hand is the reader's.
  const togglePanel = () => {
    if (panelKey) panelHidForBrowser.current.delete(panelKey);
    setPanelOpen((prev) => !prev);
  };

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
  const openSubagent = (id: string) => {
    setSelectedSubagentId(id);
    showPanel("more");
  };

  // An open session's own directory, since project- and local-scoped commands
  // differ per repo and a session can be running somewhere the picker isn't
  // pointed — a worktree, or a project switched away from since. The `@` picker
  // resolves against the same directory for the same reason, and off the same
  // expression so the two can't answer for different trees.
  const composerCwd = selectedSession?.cwd ?? projectPath;
  // What the `&` picker offers: the space's sessions in the repo this composer
  // is aimed at. The **space** is the same outer scope `visibleSessions` takes,
  // and for the same reason — a session another space is running must not be
  // nameable from here any more than it is drawable. The project filter is
  // deliberately not applied: that is a way of looking at the sidebar, where
  // this follows where the prompt is actually going, and the two come apart the
  // moment a session is open in a project the reader has filtered away.
  const composerProject = selectedSession?.projectPath ?? projectPath;
  /// Every connected Linear workspace, the default first.
  const linearWorkspaceList = linearWorkspaces(integrations.integrations);
  /// The Linear workspace the composer's project reads: its own pin, else its
  /// space's, else the default. The `#` picker lists it and the issues page
  /// opens on it, so a tag picked in either is one the send resolves in the
  /// same place — Rust's `pinned_workspace` is the other statement of this.
  const composerLinearWorkspace = useMemo(
    () =>
      workspaceFor(
        projectForPath(projects, composerProject),
        integrations.integrations?.linearSpacePins ?? {},
        linearWorkspaceList,
      ).id,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, composerProject, integrations.integrations],
  );
  /// The composer's project itself, for the filter it saved and its name.
  const composerProjectEntry = projectForPath(projects, composerProject);
  /// What that project's issues open narrowed to: its saved team and labels,
  /// while it reads the workspace they were saved in.
  const composerRepoFilter = useMemo(
    () => filterFor(composerProjectEntry, composerLinearWorkspace),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [composerProjectEntry?.linearFilter, composerLinearWorkspace],
  );
  const composerSessions = useMemo(
    () =>
      sessionIndexItems.filter(
        (i) =>
          sessionInSpace(projects, space, i.projectPath) &&
          (!composerProject || i.projectPath === composerProject),
      ),
    [sessionIndexItems, projects, space, composerProject],
  );
  const { commands: slashCommands, loading: slashCommandsLoading } = useSlashCommands(
    composerCwd,
    harness,
  );
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
  const [turnsEnded, setTurnsEnded] = useState(0);
  useEffect(() => {
    const prev = lastTurn.current;
    lastTurn.current = { sessionId: selectedSessionId, busy };
    if (prev.sessionId !== selectedSessionId || !prev.busy || busy) return;
    pullRequests.refresh();
    prMarks.refresh();
    setTurnsEnded((n) => n + 1);
  }, [selectedSessionId, busy, pullRequests.refresh, prMarks.refresh]);

  // A doc arriving on screen is re-read, because the watcher behind `DocsPanel`
  // only ever holds the *selected* session's files: anything written while the
  // reader was somewhere else was written unwatched. A turn ending needs no
  // rule of its own — the agent's write is exactly what the watcher sees.
  //
  // One value rather than three conditions: opening the tab, stepping to another
  // chip and switching session all put a different file in front of the reader,
  // and each wants the same read. A dirty draft is flagged rather than replaced,
  // so this cannot eat an edit, and a doc whose first read is still out is
  // skipped, which is what stops opening the tab reading the same file twice.
  const shownDoc =
    panelShown && activeTab === "docs" ? `${selectedSessionId}\n${activeDocPath}` : null;
  useEffect(() => {
    if (shownDoc) refreshActiveDoc(selectedSessionId);
  }, [shownDoc]);

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

  // What tells the git-backed views to re-read — cache keys, not counts. The
  // tree, the commit logs and the file list move at a turn's end, since what an
  // agent commits or creates mid-turn can wait for it; a working-tree diff also
  // moves as each tool finishes, which is the only kind of event that writes.
  // Keyed on every event, a 20-tool turn cost ~200 `git` spawns per view.
  const turnRevision = String(turnsEnded);
  const lastTool = useMemo(
    () => lastToolResult(selectedSession?.events ?? []),
    [selectedSession?.events],
  );
  const writeRevision = `${lastTool}:${turnsEnded}`;

  // Both panel bodies are presentational, and their hooks live here for the
  // same reason: the tab row needs what they know before either tab is opened —
  // whether a PR tab exists at all, and which refresh the one shared button
  // should run.
  const changesData = useChanges(
    selectedSession?.cwd ?? "",
    baseline,
    head,
    writeRevision,
    panelShown && activeTab === "changes",
    busy,
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
                onRefresh: () => refreshActiveDoc(selectedSessionId),
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
        archivedShown ? undefined : { statusBySession, asking: sidebarAsking },
        archivedShown,
        archivedShown ? [] : spaceGroups,
      ),
    [searchedSessions, projects, archivedShown, statusBySession, sidebarAsking, spaceGroups],
  );

  // Wraps downward only. Falling off the bottom returns to the newest session,
  // which is where a walk through the whole list wants to end up; the top holds
  // instead, since arriving at the oldest session by pressing *up* past the
  // newest one reads as a mistake rather than as a wrap.
  //
  // Two chords walk it at two grains. ⌘⇧ steps every row; ⌘⌥ steps `units`,
  // where a group's run is one step — so from inside a group it lands on the
  // next group, or on the row past the last one, and enters a group on its
  // first pane.
  const stepThrough = (units: SessionIndexItem[][], delta: number) => {
    if (units.length === 0) return;
    const from = units.findIndex((u) => u.some((i) => i.sessionId === selectedSessionId));
    // No selection is the empty composer — either direction enters at the top.
    const next =
      from === -1
        ? 0
        : delta > 0
          ? (from + 1) % units.length
          : Math.max(from - 1, 0);
    const item = units[next][0];
    if (item.sessionId !== selectedSessionId) {
      void handleSelectSessionIndexItem(item.sessionId);
    }
  };
  const stepSession = (delta: number) =>
    stepThrough(ordered.map((i) => [i]), delta);
  // Headings, not split groups: with no grid on screen the chord used to be
  // ⌘⇧ under another name, stepping one row at a time and never reaching the
  // next project the way its own label promised.
  const units = useMemo(
    () =>
      sessionUnits(
        searchedSessions,
        projects,
        archivedShown ? undefined : { statusBySession, asking: sidebarAsking },
        archivedShown,
        archivedShown ? [] : spaceGroups,
      ),
    [searchedSessions, projects, archivedShown, statusBySession, sidebarAsking, spaceGroups],
  );
  const stepGroup = (delta: number) => stepThrough(units, delta);

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
    showPanel("docs");
  }, [docsOpened, showPanel]);

  // The same signal for the other half of a file link: a path that is not
  // markdown opens in the Files view, which is a whole column rather than a
  // pane, so this flips the view instead of opening one. A counter for the
  // docs panel's reason — reopening a file already on screen leaves the list
  // unchanged, so only a count of *clicks* can say the reader asked.
  const lastFileOpened = useRef(filesOpened);
  useEffect(() => {
    if (filesOpened === lastFileOpened.current) return;
    lastFileOpened.current = filesOpened;
    if (!issuesOpen) setViewTab("files");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesOpened]);

  // An issue tag clicked in a prompt takes the column to the issues page and
  // opens the pane on it. Installed once: nothing here is per-session, and the
  // reader's place in the conversation is kept the way every other trip to this
  // page keeps it — the session stays selected and is still there on the way
  // back.
  useEffect(() => {
    setIssueOpener((issue) => {
      setPickedIssue(issue);
      setIssuesOpen(true);
    });
    return () => setIssueOpener(null);
  }, []);

  // A link in the transcript opens as a new tab in the session's browser and
  // brings the pane up on it, unless the full view already has it. ⌘-click,
  // or no session to hold one, goes to the system browser.
  useEffect(() => {
    setLinkOpener((url, { external }) => {
      if (external || !selectedSessionId) {
        void openUrl(url).catch(console.error);
        return;
      }
      // The session is named outright: the read lands after an await, and by
      // then the reader may be on another session whose pane must stay put.
      void openInBrowser(selectedSessionId, url, true)
        .then(() => {
          if (fullBrowserOpen) return;
          setPanelTab("browser", selectedSessionId);
          setPanelOpen(true, selectedSessionId);
        })
        .catch(() => {
          // Answered by the system browser, so the pane has nothing to say.
          clearOpenError(selectedSessionId);
          void openUrl(url).catch(console.error);
        });
    });
    return () => setLinkOpener(null);
  }, [selectedSessionId, fullBrowserOpen, setPanelTab, setPanelOpen]);

  // An element picked in the page lands in that session's draft, and the
  // composer is brought on screen to show it — off the full view and onto
  // Chat, since the composer is hidden there.
  useEffect(() => {
    setPickHandler((sessionId, element) => {
      if (!element) return;
      appendToDraft(sessionId, describePick(element));
      if (sessionId !== selectedSessionId) return;
      if (viewTab === "browser") setViewTab("chat");
      focusComposer();
    });
    return () => setPickHandler(null);
  }, [selectedSessionId, viewTab, setViewTab]);

  // The first browser tab appearing — an agent opening a page — brings the
  // pane up on Browser, once. Not while the full view is up, where the same
  // page is already the whole column. Only a change within one session
  // counts, and only from a *known* empty list: arriving at a session that
  // already holds a tab, or its first read landing, is the reader looking,
  // not the agent acting, and both used to pop the pane open (DRA-184).
  const lastTabs = useRef({ id: selectedSessionId, had: hasBrowserTabs });
  useEffect(() => {
    const was = lastTabs.current;
    lastTabs.current = { id: selectedSessionId, had: hasBrowserTabs };
    if (was.id !== selectedSessionId || was.had !== false) return;
    if (hasBrowserTabs && !fullBrowserOpen) showPanel("browser");
  }, [selectedSessionId, hasBrowserTabs, fullBrowserOpen, showPanel]);

  // Every way of arriving at a session, so none of them can forget to leave the
  // issues page. The two sidebar buttons closed it and the chords beside them
  // did not, which made ⌘N and ⌘⇧↑/↓ look inert: they moved the selection under
  // a column still full of issues, and the change only showed up on the way
  // back. The page itself is left as it was — its filters and its scroll come
  // back with it — so this is a navigation, not a dismissal. Settings cover the
  // whole window, so they close too.
  const goToSession = (go: () => void) => {
    setIssuesOpen(false);
    closeSettings();
    go();
  };

  /// Moves the whole window to another space. The screen catches up in the
  /// effect below, which answers for every way membership can change and not
  /// only for this one.
  ///
  /// Notices go here rather than there: a card raised before the switch names a
  /// session the reader has just put away, and clicking it would open that
  /// transcript. They are transient anyway, so dropping one costs a glance at
  /// something the sidebar still marks.
  ///
  /// Kept only where the session can be *shown* to belong here — `allowedInSpace`,
  /// the same reading `announce` makes, since a card and a banner say the same
  /// sentence. A settled session is in neither list the moment the reader is on
  /// the live one, so matching on the index alone kept exactly the cards nobody
  /// could account for.
  const changeSpace = (next: string | null) => {
    setStoredSpace(next);
    // Resetting the filter is leaving it, so its pick is recorded here too —
    // without this a space switch is the one way out of a filter that forgets
    // what was open in it. Nothing is restored: the effect below closes a
    // transcript that falls outside the space being entered.
    filterSelection.current[projectFilter ?? ""] = selectedSessionId;
    filterGen.current++;
    setProjectFilter(null);

    for (const notice of getNotices()) {
      const path =
        sessionIndexItems.find((i) => i.sessionId === notice.sessionId)?.projectPath ??
        sessions.find((s) => s.sessionId === notice.sessionId)?.projectPath ??
        null;
      if (!allowedInSpace(projects, next, path)) {
        dismissNotice(notice.sessionId, notice.kind);
      }
    }
  };

  /// What was selected the last time each project filter was up, keyed by the
  /// filter's own value (`""` for All Projects).
  ///
  /// A filter is a place the reader works in, not a view of one list: a session
  /// picked while looking at everything is not the session they left open in a
  /// project, so coming back to a filter has to come back to its own pick.
  ///
  /// In memory only, where the filter itself is persisted — a remembered id
  /// from a previous run would open a transcript nobody asked for on the first
  /// switch after launch, so the entry is written on the way out of a filter
  /// and nowhere else.
  const filterSelection = useRef<Record<string, string | null>>({});
  /// Bumped at every filter move, at call time, so a read across an await can
  /// tell the filter moved under it. Rendered state is a render behind.
  const filterGen = useRef(0);

  /// Drops a session from every filter's memory, so a filter cannot reopen a
  /// transcript the reader has just put away.
  ///
  /// Settling alone calls it. A deleted session is gone from the index, which
  /// is what `changeProjectFilter` judges a remembered id against — so delete
  /// needs nothing here, and calling it there would only lose the memory on a
  /// delete that *failed*.
  const forgetFilterSelection = (sessionId: string) => {
    for (const key of Object.keys(filterSelection.current)) {
      if (filterSelection.current[key] === sessionId) filterSelection.current[key] = null;
    }
  };

  /// Moves the sidebar's scope, and takes the selection and the composer with it.
  ///
  /// The composer follows because a new task started while looking at one
  /// project belongs to that project — All Projects names none, so it leaves
  /// the pick where it is rather than clearing it.
  ///
  /// A remembered session is only restored where the list still holds it under
  /// the new filter: it can have been settled, deleted, or moved out of the
  /// space since, and the empty composer is the right answer for all three.
  const changeProjectFilter = (next: string | null) => {
    if (next === projectFilter) return;
    filterSelection.current[projectFilter ?? ""] = selectedSessionId;
    filterGen.current++;
    setProjectFilter(next);
    if (next) handleSelectProject(next);

    const remembered = filterSelection.current[next ?? ""] ?? null;
    const restorable =
      remembered &&
      sessionIndexItems.some(
        (i) => i.sessionId === remembered && (!next || i.projectPath === next),
      );
    goToSession(() => {
      if (restorable) void handleSelectSessionIndexItem(remembered);
      else handleNewSession();
    });
  };

  /// Opens a session named by a notice or a banner, which can be in any project,
  /// and takes the filter to it — or the sidebar shows no row selected.
  ///
  /// Only once the select has landed: a rollback puts the old session back, and
  /// following that would undo a filter switch the reader just made. A detached
  /// project has no filter entry, so its session widens to All Projects. And
  /// only where no filter or space switch landed during the read — everything
  /// below is the click-time render's, and would undo that switch.
  const openFromNotice = async (sessionId: string) => {
    const previous = selectedSessionId;
    const gen = filterGen.current;
    const selecting = handleSelectSessionIndexItem(sessionId);
    // Past this select's own move, so any later one is somebody else's.
    const nav = navGen.current;
    if (!(await selecting) || !projectFilter) return;
    if (gen !== filterGen.current) return;
    const path = (await indexItem(sessionId))?.projectPath;
    if (gen !== filterGen.current || nav !== navGen.current) return;
    // Outside the space, the space effect below closes it instead.
    if (!path || path === projectFilter || !sessionInSpace(projects, space, path)) return;
    const next = spaceProjects.some((p) => p.path === path) ? path : null;
    filterSelection.current[projectFilter] = previous;
    filterGen.current++;
    setProjectFilter(next);
    if (next) handleSelectProject(next);
  };

  /// A session's index entry from the loaded side, else from the backend: the
  /// sidebar holds one side of the settled split, and a notice can name a
  /// session on the other.
  const indexItem = async (id: string) =>
    sessionIndexItems.find((i) => i.sessionId === id) ??
    (await invoke<SessionIndexItem | null>("session_index_item", { sessionId: id }).catch(
      () => null,
    ));

  /// A notice or banner click. A hidden session is drawn in its parent's crew,
  /// so it opens the parent — where the parent still exists.
  const openNotice = async (id: string) => {
    // Claimed by bumping before the lookups, so any move landing during them —
    // a click, a filter switch, a second notice — wins and this gives up.
    const nav = ++navGen.current;
    const gen = filterGen.current;
    const item = await indexItem(id);
    const parent = item?.hidden && item.parentSessionId ? await indexItem(item.parentSessionId) : null;
    if (nav !== navGen.current || gen !== filterGen.current) return;
    await openFromNotice(parent?.sessionId ?? id);
  };

  // A ref, since the listener is registered once and the handler reads state.
  const openFromNoticeRef = useRef(openNotice);
  openFromNoticeRef.current = openNotice;
  // The reader clicked a desktop banner. Rust has already raised the window.
  useEffect(() => {
    const unlisten = listen<string>("notification_activated", (event) => {
      goToSession(() => void openFromNoticeRef.current(event.payload));
    });
    return () => void unlisten.then((f) => f());
    // `goToSession` only closes pages through stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /// Declares a space, and reports it only where one is actually made.
  ///
  /// The check is duplicated outside the updater rather than read from inside
  /// it, and that is the point: React may call an updater twice, so a report in
  /// there would count one space as two. Judged against `spaces`, the union —
  /// re-declaring a name some project already carries as a tag is not a new
  /// space to the reader, whatever the declared half of the list says.
  const createSpace = (name: string) => {
    setDeclaredSpaces((prev) => (prev.includes(name) ? prev : [...prev, name]));
    if (!spaces.includes(name)) trackFeature("space_created");
  };

  /// Steps a space one place in the order the switcher walks.
  ///
  /// The **whole** list goes down, not the declared half of it: order is the
  /// declared list, and a space carried only by a project's tag has no place in
  /// it yet — so a name is declared here on the way past, which is the only way
  /// it can have somewhere to be moved to. Membership is untouched either way,
  /// since the tag on the project is what records that.
  const moveSpaceBy = (name: string, delta: number) =>
    setDeclaredSpaces(moveSpace(spaces, name, delta));

  /// Renames a space wherever it is written down: every project carrying the
  /// tag, the declared list, and the reader's own pick.
  ///
  /// The tags move first and in **one** call, and the local record follows only
  /// once that lands. A loop of writes with the record updated up front left
  /// half-renamed tags beside a list claiming the rename was done, which is a
  /// disagreement nothing on screen could explain.
  const renameSpace = async (from: string, to: string) => {
    if (!(await retagSpace(from, to))) return;
    setDeclaredSpaces((prev) => [...new Set(prev.map((s) => (s === from ? to : s)))]);
    // Groups are filed by the space's name, so they follow it — left tagged
    // with the old one they would vanish, and come back under a later space
    // that happened to take the name.
    setGroups((prev) => prev.map((g) => (g.space === from ? { ...g, space: to } : g)));
    if (storedSpace === from) setStoredSpace(to);
    // Its Linear pin moved with it in Rust, which nothing here saw.
    integrations.reload();
  };

  /// Removes a space and files its projects under none. The projects and their
  /// sessions are untouched — a space is a way of looking at them, so losing one
  /// costs the view and never the work.
  const removeSpace = async (name: string) => {
    if (!(await retagSpace(name, null))) return;
    setDeclaredSpaces((prev) => prev.filter((s) => s !== name));
    // Its groups go where its projects go: under none, which is every project.
    setGroups((prev) => prev.map((g) => (g.space === name ? { ...g, space: null } : g)));
    if (storedSpace === name) changeSpace(null);
    integrations.reload();
  };

  /// Keeps what is *on screen* inside the active space — the composer's project
  /// and the open transcript, neither of which the sidebar's filtering reaches.
  ///
  /// An effect rather than three lines inside the switcher, because switching
  /// is not the only way a session leaves the space it was in: filing a project
  /// into another space or detaching it moves the same boundary, and a stale
  /// notification opening a session moves the reader across it. Written as
  /// "what is showing must be in the space" rather than as a list of the ways
  /// it stops being, each of which was its own bug.
  ///
  /// The project is judged first and independently: a space holding nothing is
  /// an ordinary state, and clearing the pick there is what stops the composer
  /// starting a task in a project the reader can no longer see.
  ///
  /// A session whose project neither the index nor the loaded snapshot can name
  /// is left alone. That is "we cannot tell", not "it is elsewhere", and
  /// closing a transcript on a guess is worse than drawing one a moment longer.
  ///
  /// **Layout, not effect**: an ordinary effect runs after the browser paints,
  /// so the switch drew one frame of the transcript being switched away from.
  /// A frame is nothing to a reader who chose to switch and everything to the
  /// room watching them share the screen, which is the whole reason spaces
  /// exist. The body is two array scans, which is what makes blocking paint on
  /// it affordable.
  useLayoutEffect(() => {
    if (projectPath && !spaceProjects.some((p) => p.path === projectPath)) {
      handleSelectProject(spaceProjects[0]?.path ?? null);
    }

    if (!selectedSessionId) return;
    const openPath =
      selectedSession?.projectPath ??
      sessionIndexItems.find((i) => i.sessionId === selectedSessionId)?.projectPath;
    if (openPath && !sessionInSpace(projects, space, openPath)) {
      goToSession(handleNewSession);
    }
    // The membership question and its two answers. `handleSelectProject` and
    // `handleNewSession` are rebuilt every render, so listing them would run
    // this on every one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space, projects, spaceProjects, projectPath, selectedSessionId, selectedSession, sessionIndexItems]);

  /// The sidebar's own "New space", which is a request for the field rather
  /// than for a space — naming it is Settings' job, so this only opens the tab.
  /// Where a second Linear workspace is added: the connect pane is for the
  /// reader with none, and "another" belongs beside the list it adds to.
  const openLinearSettings = () => {
    setSettingsTab("integrations");
    setSettingsOpen(true);
  };

  const openNewSpace = () => {
    setSettingsTab("spaces");
    setNamingSpace(true);
    setSettingsOpen(true);
  };

  /// Leaves the issues page for the empty composer, with the issue tagged in
  /// the draft.
  ///
  /// The tag alone is the whole handoff: `expand_tags` resolves it out of the
  /// prompt text on send, so nothing is linked here. It lands in the composer
  /// rather than starting a session, which is what leaves the project, the
  /// model and the harness still to be picked.
  const workOnIssue = (issue: { identifier: string; title: string; workspace?: string | null }) => {
    // A tag carries no workspace, and the send resolves it in the one the new
    // task's project reads. From a page switched to another workspace that is
    // the wrong issue wherever both hold the identifier — so say so rather
    // than draft a tag that links something else.
    const target = workspaceFor(
      projectForPath(projects, projectPath),
      integrations.integrations?.linearSpacePins ?? {},
      linearWorkspaceList,
    ).id;
    // `target` is null where the project reads a default Linear never
    // identified — and an issue carrying a workspace was read from one that
    // was identified, so it is another workspace's all the same.
    if (issue.workspace && issue.workspace !== target) {
      const project = projectForPath(projects, projectPath)?.name ?? "This project";
      pushNotice({
        sessionId: issue.identifier,
        kind: "issue-failed",
        label: "Could not start work",
        subject: issue.identifier,
        detail: `${issue.identifier} is in ${workspaceName(linearWorkspaceList, issue.workspace)}, but ${project} reads ${workspaceName(linearWorkspaceList, target)}. Pin it to that workspace in Settings first.`,
      });
      return;
    }

    goToSession(handleNewSession);
    // The same two things the `#` picker's own pick does, and the draft reads
    // as prose without either. **The title is remembered**, since nothing
    // closes an issue tag and the chip cannot find its end otherwise — so the
    // Linear tag chipped as the bare identifier with its title left beside it
    // in plain text. **And a space follows it**, since a chip only forms once
    // the caret has left the word: dropped straight in, the caret sat at the
    // tag's end and the whole run stayed drawn as raw text.
    rememberIssueTitle(issue.identifier, issue.title);
    appendToDraft(null, issueTag(issue.identifier, issue.title));
    // A space after it, which `appendToDraft` trims off — its rule is
    // dictation's, where whatever the model padded its words with is noise. A
    // tag wants one: a chip only forms once the caret has left the word, so
    // without it the whole run stayed drawn as raw text.
    writeDraft(null, `${readDraft(null)} `);
    focusComposerEnd();
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
      forgetFilterSelection(sessionId);
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
      // Unsettling is the reader saying they found what they came for, so the
      // query that found it has done its job — and left standing it would hide
      // the row they just acted on, since the list it lands in is filtered too.
      setSearch("");
      setSearchOpen(false);

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

  const toggleSidebar = () => {
    hidForBrowser.current = false;
    setCollapsed((prev) => !prev);
  };
  useHotkey("sidebar.toggle", toggleSidebar);
  // Takes the sidebar with it: the field lives there, and a chord that opened a
  // search nobody can see would be worse than no chord. `autoFocus` covers the
  // field this press mounts; the select covers the one already on screen, which
  // is also what makes ⌘F on a query a replace rather than an append.
  useHotkey("search", () => {
    setCollapsed(false);
    setSearchOpen(true);
    document.querySelector<HTMLInputElement>(`#${SEARCH_INPUT_ID}`)?.select();
  });
  useHotkey("session.new", () => goToSession(handleNewSession));
  // Steps the composer's project picker, and only while that picker is on
  // screen: it is drawn for a new task alone, and `enabled` unregisters rather
  // than no-opping, so a session's composer doesn't have ⌘⇧P eaten from it.
  // Wraps, since one key with a clamp dead-ends on the last project with no way
  // back. Nothing picked yet finds no index and lands on the first, which is
  // also the answer for a project detached out from under the pick.
  useHotkey(
    "project.next",
    () => {
      const next =
        spaceProjects[
          (spaceProjects.findIndex((p) => p.path === projectPath) + 1) % spaceProjects.length
        ];
      if (next) handleSelectProject(next.path);
    },
    {
      // The chord steps exactly what the picker draws, which under a space is
      // that space's projects — a chord landing on one the menu never offered
      // is a session started somewhere the reader cannot see.
      enabled: !selectedSessionId && !issuesOpen && spaceProjects.length > 1,
    },
  );
  // Steps the sidebar's project filter, All Projects included, in the order the
  // filter itself draws. Wraps, for the same reason the picker's own tap does:
  // one key with a clamp dead-ends with no way back. Bound only where there is
  // more than one entry to step between.
  const stepProjectFilter = (delta: number) => {
    const entries: (string | null)[] = [null, ...spaceProjects.map((p) => p.path)];
    const from = entries.indexOf(projectFilter);
    const at = from === -1 ? 0 : from;
    changeProjectFilter(entries[(at + delta + entries.length) % entries.length]);
  };
  useHotkey("filter.prev", () => stepProjectFilter(-1), {
    enabled: spaceProjects.length > 0,
  });
  useHotkey("filter.next", () => stepProjectFilter(1), {
    enabled: spaceProjects.length > 0,
  });

  // ⌘⇧ rather than plain ⌘: the composer is focused most of the time, where
  // ⌘↑/↓ is the webview's own jump-to-start/end of the input.
  useHotkey("session.prev", () => goToSession(() => stepSession(-1)));
  useHotkey("session.next", () => goToSession(() => stepSession(1)));
  useHotkey("group.prev", () => goToSession(() => stepGroup(-1)));
  useHotkey("group.next", () => goToSession(() => stepGroup(1)));
  // ⌘⌥ digits, the bare ⌘ digits being the view tabs' below. Not ⌘⇧, which
  // macOS spends on screenshots for exactly these digits. Bound only while a
  // grid is *on screen*: with none ⌘⌥1 has nothing to point at and must not eat the key,
  // and under the Diff tab or the issues page ⌘W would close a pane the
  // reader cannot see.
  const gridShown = !!mainGroup && !issuesOpen && viewTab === "chat";
  const paneIds = mainGroup ? paneOrder(mainGroup) : [];
  // Keyboard focus moves with the pane. A click moves it by itself, but a
  // chord left it on whatever the old pane held — a link, a subagent control
  // — and Enter there then acted through the *selected* session, since every
  // opener resolves ownership from the selection. The composer is where the
  // reader's next keystroke belongs anyway.
  const focusPane = (n: number) => {
    const id = paneIds[n - 1];
    if (!id) return;
    void handleSelectSessionIndexItem(id);
    focusComposer();
  };
  // Nine digits, so a tenth pane has no chord — it still takes a click. A
  // fixed list, so the hook count never moves between renders.
  for (const n of PANE_DIGITS) useHotkey(`pane.${n}`, () => focusPane(n), { enabled: gridShown });
  // ⌘W closes the innermost thing the main column has open, which is what it
  // means in every editor and browser this app is read beside. The views are
  // mutually exclusive, so the chain is an ordering rather than an
  // arbitration — bar the last arm, which is the reader on Chat with the
  // browser beside it in the panel and no grid to close a pane out of.
  const closeBrowserTab = () => {
    if (!selectedSessionId || isRecording(selectedSessionId)) return;
    // The pending tab has no browser behind it, so it is dropped rather than
    // closed — and it is what the reader is looking at while it is up.
    if (pendingBrowserTab) return setPendingTab(selectedSessionId, false);
    const open = browserTabs?.find((tab) => tab.active);
    if (open) void closeTab(selectedSessionId, open.id);
  };
  // `viewTab` is per session and the issues page does not clear it, so a
  // reader who opened Issues from the Files view still has `activeFile`
  // naming a tab in a view nobody can see — and ⌘W there closed it silently.
  // Every other arm already carries the guard: `fullBrowserOpen` and
  // `gridShown` both hold `!issuesOpen`, and `panelShown` is the pane the
  // page hides.
  const fileShown = !issuesOpen && viewTab === "files" && !!activeFile;
  const closeTabOrPane = () => {
    if (!selectedSessionId) return;
    if (fileShown && activeFile) return closeFile(selectedSessionId, activeFile);
    if (fullBrowserOpen) return closeBrowserTab();
    if (gridShown) return closeSessionPane(selectedSessionId);
    if (panelShown && activeTab === "browser") closeBrowserTab();
  };
  // Bound only where it has something to close: `useHotkey` claims every chord
  // it matches, and a ⌘W that eats the key and does nothing is worse than one
  // the app never had.
  const hasCloseTarget =
    fileShown ||
    ((fullBrowserOpen || (panelShown && activeTab === "browser")) &&
      (pendingBrowserTab || !!hasBrowserTabs)) ||
    gridShown;
  useHotkey("tab.close", closeTabOrPane, { enabled: hasCloseTarget });
  // ⌘E for the right pane against ⌘B for the left.
  //
  // Bound to the raw toggle rather than to `handleTogglePanel`, deliberately:
  // that one picks a tab on the way open, which is right for a button the
  // reader aimed at and wrong for a chord that draws nothing and so promises
  // nothing. Which means the issues-page guard has to be repeated here — it
  // lived only in `handleTogglePanel` at first, so the button honoured it and
  // the chord went straight past it to a pane that is not on screen.
  useHotkey("panel.toggle", () => {
    if (issuesOpen) return setPickedIssue(null);
    togglePanel();
  });
  // Bound only where a crew could be drawn, since `useHotkey` claims a chord it
  // is listening for — unbound elsewhere, ⌘⇧C stays free for whatever the
  // reader rebinds onto it rather than being swallowed by a column that has
  // nowhere to appear.
  useHotkey("crew.toggle", toggleCrew, { enabled: crewAvailable });
  // ⌘⇧[ / ⌘⇧] — the browser and editor chord for stepping through tabs, so it
  // arrives already known. The shift layout reaches `key`, so the character is
  // `{` rather than `[`; the physical key rides along for the engines that
  // report the unshifted one — see `code`.
  useHotkey("panel.tab.prev", () => stepTab(-1));
  useHotkey("panel.tab.next", () => stepTab(1));
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
  //
  // The browser reloads its page. A press inside the page never gets here —
  // Chromium has the key, and cef.rs reloads there.
  const browserShown = fullBrowserOpen || (panelShown && activeTab === "browser");
  useHotkey("panel.refresh", () => {
    // "Re-read what I am looking at", the same rule the session case follows:
    // the pane wins where one is open, and the list has it otherwise.
    if (issuesOpen) {
      if (pickedIssue) return pickedIssueData.refresh();
      return issuesRefreshRef.current?.();
    }
    if (browserShown && selectedSessionId) {
      if (!pendingBrowserTab && browserTabs?.some((tab) => tab.active)) {
        void navigate(selectedSessionId, "reload");
      }
      return;
    }
    if (panelShown) panelRefresh?.onRefresh();
  });
  // ⌘T, the chord every browser gives a new tab. Bound only while the browser
  // is on screen, so it stays free everywhere else.
  useHotkey("browser.newTab", () => {
    if (selectedSessionId && !isRecording(selectedSessionId)) setPendingTab(selectedSessionId, true);
  }, {
    enabled: browserShown && !!selectedSessionId,
  });
  // ⌘S writes the doc on screen. Unregistered rather than a no-op off that tab:
  // `useHotkey` claims every chord it matches, and ⌘S is the browser's own save
  // — left bound everywhere it would eat the key from nothing at all.
  useHotkey("doc.save", () => saveActiveDoc(selectedSessionId), {
    enabled: panelShown && activeTab === "docs",
  });
  // By position in the tab row, so a third view needs only a third line here.
  // No-ops without a session, where there is no row to switch — and on the
  // issues page, where the row is not drawn: switching an invisible tab looks
  // like nothing happening and then shows up as the wrong view on the way back.
  //
  // The bare ⌘ digits, the way every browser and editor numbers its tabs; the
  // split view's panes take ⌘⌥ above.
  useHotkey("view.chat", () => !issuesOpen && setViewTab("chat"));
  useHotkey("view.changes", () => !issuesOpen && setViewTab("changes"));
  useHotkey("view.browser", () => !issuesOpen && setViewTab("browser"));
  useHotkey("view.files", () => !issuesOpen && setViewTab("files"));
  // ⌘, — every macOS app's preferences chord, and the only way into settings
  // while the sidebar is collapsed and its gear gone with it. Safe to take for
  // `useHotkey`'s usual pair of reasons: it claims the chord, and the app's
  // custom menu carries no Settings item to swallow the key first.
  useHotkey("settings", () => setSettingsOpen(true));
  // No notice on landing: the whole window changing is the answer.
  useHotkey("theme.next", cycleTheme);
  useHotkey("zoom.in", () => stepZoom(1));
  useHotkey("zoom.out", () => stepZoom(-1));
  useHotkey("zoom.reset", () => stepZoom(0));
  // Both only mean anything before a session exists — the agent *is* the child
  // process and the worktree is where it starts — so they are unregistered
  // rather than no-ops there. `useHotkey` claims every chord it matches, and
  // ⌘⇧T is reopen-closed-tab in a webview: left bound on a session that cannot
  // use it, it would eat the key and do nothing.
  const composingNewSession = !selectedSessionId && !issuesOpen;
  // Steps the picker's own row in its own order, rather than toggling between
  // two — a toggle written when there were two silently never reached pi.
  const enabledAgents = useEnabledAgents();
  useHotkey("harness.next", () => setHarness(nextHarness(harness, enabledAgents)), {
    enabled: composingNewSession,
  });
  // A new session never starts on an agent the reader switched off. Only the
  // composer moves: a session already on one keeps it.
  useEffect(() => {
    if (composingNewSession && !enabledAgents.includes(harness)) setHarness(enabledAgents[0]);
  }, [composingNewSession, enabledAgents, harness, setHarness]);
  useHotkey("worktree.toggle", () => setUseWorktree((v) => !v), {
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
  // what the trigger does in one click. Sane only because the cycle is the
  // reader's own shortlist, so a wrong landing is one more press away from
  // right. Leaves each model's own remembered effort alone, same as picking it
  // from the menu.
  //
  // `cycledModels` is the picker's own list, and sharing it is what keeps the
  // chord honest: it must never land on a model the menu doesn't draw.
  useHotkey("model.next", () => {
    const cycle = cycledModels(models, harness, modelId);
    if (cycle.length < 2) return;
    const index = cycle.findIndex((m) => m.id === modelId);
    const next = cycle[(index + 1) % cycle.length];
    handleModelChange(next.id, null);
  }, { enabled: !lockedMidTurn(harness, "model", busy) });
  // ⌘⇧E for effort, beside ⌘E for the right pane — near enough to remember and
  // no collision, since `useHotkey` matches Shift exactly and neither listener
  // answers the other's chord. No `code`: that option is for a chord whose
  // character *changes* under Shift, and Shift+E is still an E — the matcher
  // lowercases both sides.
  useHotkey("effort.next", () => {
    const next = nextEffort(models.find((m) => m.id === modelId), effort);
    if (next) handleModelChange(modelId, next);
  }, { enabled: !lockedMidTurn(harness, "effort", busy) });
  // Shares ⌘⇧F with `issues.search`, which is the one documented pair in
  // `SHARED_CHORDS`: that binding is enabled only while the issues page is up
  // and this one only while it is not, so the chord belongs to whichever is on
  // screen. Gated on `offersFast` rather than on the harness, the same question
  // the switch in the picker asks — a chord that toggled a setting no control
  // shows, on a model that would ignore it, is a key that silently changes the
  // index and nothing else.
  useHotkey(
    "composer.fast",
    () => setFast(!fast),
    {
      enabled:
        !issuesOpen &&
        !lockedMidTurn(harness, "fast", busy) &&
        offersFast(harness, models.find((m) => m.id === modelId), composingNewSession),
    },
  );
  // Opens, and does nothing where the page is already up — the same answer the
  // sidebar row gives, since that is the only other route in. Not a toggle:
  // nothing on that page opens the pane either (⌘E closes only there), and a
  // chord that closed it would have to pick somewhere to land, which is the
  // guess `goToSession` exists so nothing has to make.
  useHotkey("issues.open", () => setIssuesOpen(true));
  const fullscreen = useFullscreen();
  useGlass(fullscreen);

  // The session on screen, whether or not its transcript has landed. A session
  // just selected is not in memory for the round trip that reads it, and
  // `selectedSession` is null for exactly that window — so every arrangement
  // gated on it, the centred composer, the view tabs and the right pane, was
  // torn down at the click and rebuilt when the read answered. In the main
  // column that read as the switch; beside a crew it was the anchor, the pane
  // and the column remounting under rows that had not moved, and only ever on
  // a row's first open (DRA-274). The index carries what the layout needs of
  // it meanwhile. The transcript still waits on the snapshot, and draws an
  // empty pane until it lands rather than a different screen.
  const shownSession =
    selectedSession ?? sessionIndexItems.find((i) => i.sessionId === selectedSessionId) ?? null;

  // A left panel with the sidebar collapsed takes the window's left edge, and
  // with it the traffic lights the header would otherwise clear. Fullscreen has
  // none to clear.
  const panelAtLeftEdge =
    panelSide === "left" &&
    collapsed &&
    !fullscreen &&
    (issuesOpen ? !!pickedIssue : !!shownSession && panelShown);

  // What every transcript on screen reports back through: the main column, a
  // split pane and a crew strip alike.
  const paneChat: PaneChat = {
    onOpenSubagent: openSubagent,
    onOpenSession: (id) => void handleSelectSessionIndexItem(id),
    onOpenSubagentPanel: () => showPanel("more"),
    onOpenPlan: () => showPanel("plan"),
    onRespondPermission: handleRespondPermission,
    onAnswerQuestions: handleAnswerQuestions,
    onSendNow: handleInterrupt,
  };

  return (
    <TooltipProvider>
    <DiffWorkerPool pair={codeThemePair}>
    {/* Hidden, not unmounted, while settings take the window: transcripts,
        scroll pins and drafts wait here. `display: none` is also what takes
        the browser's native view down, its pane measuring zero. */}
    <div className={cn("h-full w-full", settingsOpen && "hidden")}>
    <AppShell
      // The issues page fills the column, so the centred empty-composer state
      // is wrong there even with no session selected.
      centered={!shownSession && !issuesOpen}
      panelLeft={panelSide === "left"}
      overlay={singleDrop && <DropZone region={singleDrop.region} label={singleDrop.label} />}
      // Chat's alone, and not a `TabBody` — the other views answer questions
      // about a repository rather than about a conversation, and a split is
      // already several conversations side by side, where a crew beside one
      // pane of it would be a third arrangement of the same column.
      crewStacked={!crewBeside}
      crew={
        crewDrawn ? (
          <Crew
            stacked={!crewBeside}
            rows={crew}
            open={crewOpen}
            selectedId={selectedSessionId}
            paneState={paneState}
            prFor={prMarks.prFor}
            onToggle={toggleCrewRow}
            onFocus={focusSession}
            onOpenInMain={openCrewRowInMain}
            onShowInSidebar={(id) => void setSessionFlags(id, { hidden: false })}
            composing={composing}
            active={!issuesOpen && viewTab === "chat"}
            chat={paneChat}
          />
        ) : undefined
      }
      sidebar={
        <Sidebar
          items={searchedSessions}
          search={search}
          onSearchChange={setSearch}
          searchOpen={searchOpen}
          onSearchOpenChange={setSearchOpen}
          projects={spaceProjects}
          spaces={spaces}
          space={space}
          onSpaceChange={changeSpace}
          onNewSpace={openNewSpace}
          // Only while the dialog is actually up: it is cleared on close, so a
          // cancelled naming puts the switcher back on All Spaces by itself.
          namingSpace={settingsOpen && namingSpace}
          projectFilter={projectFilter}
          onProjectFilterChange={changeProjectFilter}
          statusBySession={statusBySession}
          askingSessions={sidebarAsking}
          prFor={prMarks.prFor}
          // Cleared while the page is up. The column is showing issues, so a
          // lit row would name a session that is nowhere on screen — and the
          // selection itself is kept, which is what makes coming back free.
          selectedSessionId={issuesOpen ? null : selectedSessionId}
          collapsed={collapsed}
          onToggleCollapsed={toggleSidebar}
          onOpenSettings={() => setSettingsOpen(true)}
          // The sidebar is the reader leaving the crew, and it has to say so
          // outright rather than lean on the selection moving. A row already
          // selected — the crew member they are reading — moves nothing, so
          // the anchor stood and the main column went on drawing the parent:
          // the click read as broken, and the only way into that session's
          // full view was ⌘-clicking it over in the crew, or clicking away to
          // another row and back.
          onSelect={(sessionId) => goToSession(() => void selectAndLeaveCrew(sessionId))}
          onPrefetch={(sessionId) => void ensureLoaded(sessionId)}
          groups={spaceGroups}
          onDropSession={dropSession}
          splitLearned={splitLearned}
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
          onMarkUnread={markSessionUnread}
          archivedShown={archivedShown}
          archivedRequested={archivedRequested}
          onToggleArchived={() => setShowArchived((v) => !v)}
          updateStatus={updateStatus}
          updateBlocked={anyRunning}
          updateManual={updateManual}
          onInstallUpdate={() => void installUpdate()}
        />
      }
      header={
        <header
          // `overflow-hidden` is the containment: whatever runs out of room in
          // here must clip at the column's edge, never spill over the pane
          // beside it. Every child below decides how it gives up width; this
          // decides that it has to.
          className="flex h-(--titlebar-h) shrink-0 items-center gap-2 overflow-hidden px-3"
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
                fullscreen ? "-ml-1" : !panelAtLeftEdge && "pl-(--traffic-lights-w)",
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
            // The group's name over a grid: each pane's header already names
            // its session, and the focused one's repeated up here read as a
            // second line of the same row.
            standIn={issuesOpen ? "Issues" : mainGroup ? groupName(mainGroup) : null}
            parent={
              hiddenParent && {
                title: hiddenParent.title,
                onSelect: () =>
                  goToSession(() => void handleSelectSessionIndexItem(hiddenParent.sessionId)),
              }
            }
            className="flex-1"
          />

          {!issuesOpen && shownSession && <ViewTabs tab={viewTab} onChange={setViewTab} />}

          {issuesOpen
            ? // Only once something is open to close. Nothing on this page can
              // *open* the pane — a row does that — so a toggle drawn at rest
              // would be a control with one dead state.
              pickedIssue && (
                <PanelToggle onToggle={() => setPickedIssue(null)} open changes={false} />
              )
            : shownSession && (
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
            side={panelSide}
            clearTrafficLights={panelAtLeftEdge}
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
              <MountOnce when>
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
              </MountOnce>
            </TabBody>
          </RightPanel>
        ) : // Mounted whenever a session is, open or not — closing or switching
        // tabs only hides, so reopening shows what was already there instead of
        // refetching and re-highlighting it. `active` is what stops the hidden
        // changes tab from snapshotting the working tree in the background.
        shownSession ? (
          <RightPanel
            side={panelSide}
            clearTrafficLights={panelAtLeftEdge}
            open={panelShown}
            tab={activeTab}
            onTabChange={setPanelTab}
            counts={{
              pr: prBadgeCount(pullRequests.prs),
              // Only above one: a tab reading "Issue 1" says what the tab
              // already says, and the count is news exactly when there is more
              // than one thing behind it.
              issue: sessionIssues.length > 1 ? sessionIssues.length : 0,
              // Same rule, and beside it so the rule reads once: the count is
              // news exactly when there is more than one file behind the tab.
              docs: docs.length > 1 ? docs.length : 0,
            }}
            tabs={tabs}
            refresh={panelRefresh}
            cwd={shownSession.cwd}
            widthKey={shownSession.sessionId}
          >
            <TabBody active={activeTab === "changes"}>
              <MountOnce when={panelShown && activeTab === "changes"}>
              <ChangesPanel
                cwd={shownSession.cwd}
                baseline={baseline}
                onOpenRepo={() => setViewTab("changes")}
                {...changesData}
              />
              </MountOnce>
            </TabBody>
            <TabBody active={activeTab === "browser"}>
              <MountOnce when={panelShown && activeTab === "browser"}>
              <BrowserPane
                sessionId={shownSession.sessionId}
                active={panelShown && activeTab === "browser"}
                mode="panel"
                fullOpen={fullBrowserOpen}
                onExpand={expandBrowser}
                onCollapse={collapseBrowser}
              />
              </MountOnce>
            </TabBody>
            <TabBody active={activeTab === "more"}>
              <MorePanel
                todos={sessionTodos}
                live={busy}
                subagents={{
                  runs: subagents,
                  selectedId: selectedSubagentId,
                  resultByCallId,
                  live: busy || backgroundTasks.length > 0,
                  onSelect: setSelectedSubagentId,
                  onStopTask: handleStopTask,
                }}
              />
            </TabBody>
            <TabBody active={hasPrTab && activeTab === "pr"}>
              <MountOnce when={panelShown && hasPrTab && activeTab === "pr"}>
              <PrPanel
                branch={prBranch}
                cwd={shownSession.cwd}
                {...pullRequests}
                // Pinned at the press: with no pick the default follows an
                // *open* PR, so a merge would flip the pane to Changes under
                // the reader waiting to see it land.
                act={(number, action) => {
                  setPanelTab("pr");
                  return pullRequests.act(number, action);
                }}
              />
              </MountOnce>
            </TabBody>
            <TabBody active={hasDocsTab && activeTab === "docs"}>
              {/* On having docs rather than on being shown: its watcher is
                  what flags a doc changed on disk, open tab or not. */}
              <MountOnce when={hasDocsTab}>
              <DocsPanel
                sessionId={selectedSessionId}
                active={panelShown && activeTab === "docs" && viewTab === "chat"}
              />
              </MountOnce>
            </TabBody>
            <TabBody active={hasPlanTab && activeTab === "plan"}>
              <PlanPanel sessionId={selectedSessionId} />
            </TabBody>
            <TabBody active={hasIssueTab && activeTab === "issue"}>
              <MountOnce when={panelShown && hasIssueTab && activeTab === "issue"}>
              <IssuePanel
                sessionId={selectedSessionId}
                issues={sessionIssues}
                onUnlink={unlinkIssue}
                {...issueData}
              />
              </MountOnce>
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
          commandsLoading={slashCommandsLoading}
          cwd={composerCwd}
          linearWorkspace={composerLinearWorkspace}
          repoFilter={composerRepoFilter}
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
          isNewTask={!shownSession}
          target={composerTarget}
          issuesConnected={issuesConnected}
          issueTrackers={integrations.connected}
          sessions={composerSessions}
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
              disabled={!selectedSessionId || !!sendHeld}
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
          held={sendHeld}
          agentUpdate={
            !selectedSessionId && (
              <AgentUpdateLine
                harness={harness}
                // pi and fx overwrite files a live child reads; the other three
                // install beside it, so only these two wait on a running turn.
                waiting={
                  (harness === "pi" || harness === "fx") &&
                  sessionIndexItems.some(
                    (s) =>
                      s.harness === harness && statusBySession[s.sessionId] === "in_progress",
                  )
                }
              />
            )
          }
          toolbar={
            <ComposerToolbar
              harness={harness}
              onHarnessChange={setHarness}
              models={models}
              modelId={modelId}
              effort={effort}
              fast={fast}
              onFastChange={setFast}
              fastNote={fastNote}
              onModelChange={handleModelChange}
              onRefreshModels={refreshModels}
              onReloadModels={reloadModels}
              onSeedProvider={seedFxModels}
              loadingModels={loadingModels}
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
              projects={spaceProjects}
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
              busy={busy}
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
        <MountOnce when={issuesOpen}>
        <IssuesView
          active={issuesOpen}
          picked={pickedIssue?.identifier ?? null}
          onPick={setPickedIssue}
          onWorkOn={workOnIssue}
          refreshRef={issuesRefreshRef}
          connected={integrations.connected}
          onConnect={integrations.connect}
          connecting={integrations.busy}
          connectError={integrations.error}
          onRecheckGithub={integrations.recheckGithub}
          linearWorkspaces={linearWorkspaceList}
          projectWorkspace={composerLinearWorkspace}
          project={composerProject ?? null}
          onAddWorkspace={openLinearSettings}
          repoFilter={composerRepoFilter}
          repoName={composerProjectEntry?.name ?? null}
          onSaveRepoFilter={
            composerProjectEntry
              ? (filter) => setProjectLinearFilter(composerProjectEntry.path, filter)
              : undefined
          }
        />
        </MountOnce>
      </TabBody>

      {/* Hidden rather than unmounted, the same bargain the right panel's tabs
          make: the transcript keeps its scroll position and its highlighted
          diffs, and the repo view keeps its selection and its reads. */}
      <TabBody active={!issuesOpen && viewTab === "chat"}>
      {mainGroup ? (
        <SplitView
          columns={paneColumns}
          focusedId={selectedSessionId}
          paneState={paneState}
          groups={spaceGroups}
          onFocus={(id) => void handleSelectSessionIndexItem(id)}
          onClose={closeSessionPane}
          active={!issuesOpen && viewTab === "chat"}
          chat={paneChat}
        />
      ) : (
      // The single view is one drop target: a row let go here opens beside
      // the selected session, on whichever side it was let go.
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        {...{ [DROP_ATTR]: selectedSessionId ?? undefined }}
      >
      {/* `paneState` rather than the selected session's own fields, which are
          the same values read off the same maps — it is what lets this draw
          the crew's anchor while something else is selected, and it is the
          function every other transcript in the app already goes through.

          Dimmed on the same rule as a crew row, since while the composer is
          pointed at a crew session this column is one of the transcripts
          giving way. */}
      <div
        // Pointerdown bubbles here before the click it precedes, so a control
        // inside the transcript acts on an already-focused session; keyboard
        // focus entering it is the same claim. Only where it is not already
        // the one selected, which with no crew up is always.
        onPointerDown={() =>
          mainSessionId && mainSessionId !== selectedSessionId && focusSession(mainSessionId)
        }
        onFocus={() =>
          mainSessionId && mainSessionId !== selectedSessionId && focusSession(mainSessionId)
        }
        className={cn(
          "min-h-0 flex-1 transition-opacity duration-150 ease-out",
          composing && mainSessionId !== selectedSessionId && "opacity-35",
        )}
      >
        <Chat
          {...paneState(mainSessionId ?? "")}
          {...paneChat}
          crowded={!collapsed && (panelShown || crewUp || (issuesOpen && !!pickedIssue))}
          // Its own chords only while the composer is pointed here — the same
          // gate a split pane takes, since Stop and scroll-to-bottom act on
          // the session being written to.
          active={!issuesOpen && viewTab === "chat" && mainSessionId === selectedSessionId}
        />
      </div>
      {singleDrop && <DropZone region={singleDrop.region} label={singleDrop.label} />}
      </div>
      )}
      </TabBody>

      {selectedSession && (
        // Keyed by session so the selection, the sub-tab and the commit box
        // reset with it. Cheap to remount: the reads behind it are cached by
        // tree id at module level and survive the unmount.
        <TabBody active={!issuesOpen && viewTab === "changes"}>
          <MountOnce when={!issuesOpen && viewTab === "changes"}>
          <ChangesView
            key={selectedSession.sessionId}
            cwd={selectedSession.cwd}
            active={!issuesOpen && viewTab === "changes"}
            revision={turnRevision}
            writeRevision={writeRevision}
            busy={busy}
          />
          </MountOnce>
        </TabBody>
      )}

      {selectedSession && (
        <TabBody active={!issuesOpen && viewTab === "browser"}>
          <MountOnce when={fullBrowserOpen}>
          <BrowserPane
            sessionId={selectedSession.sessionId}
            active={fullBrowserOpen}
            mode="full"
            onCollapse={collapseBrowser}
          />
          </MountOnce>
        </TabBody>
      )}

      {selectedSession && (
        // Keyed by session so the expanded tree resets with it. The tab strip
        // does not: its store is per session and outlives the remount, so what
        // comes back is that session's own files.
        <TabBody active={!issuesOpen && viewTab === "files"}>
          <MountOnce when={!issuesOpen && viewTab === "files"}>
          <FilesView
            key={selectedSession.sessionId}
            sessionId={selectedSession.sessionId}
            cwd={selectedSession.cwd}
            active={!issuesOpen && viewTab === "files"}
            revision={turnRevision}
          />
          </MountOnce>
        </TabBody>
      )}
    </AppShell>
    </div>
    {/* Outside `AppShell` on purpose: it is fixed to the window rather than
        placed in the layout, and the shell has no slot that isn't a pane. */}
    <NoticeStack
      onSelect={(id) => goToSession(() => void openNotice(id))}
      // The session and the pane both, since the card is about something the
      // transcript does not show. The pick is written the same way
      // `usePullRequest`'s `onOpened` writes it — `activeTab` honours a
      // standing pick, and opening the pane stores "changes" on its own.
      onOpenPr={(id) => {
        void openFromNotice(id);
        showPanel("pr", id);
      }}
      onDeleteWorktree={(id) => removeWorktree(id)}
    />
    <DragGhost />
    <QuitDialog />
    <LinkDialog />
    {/* Mounted here rather than in the sidebar, which unmounts whole when it
        collapses and would take ⌘, with it. Not before its first open, which
        is also the only place a transcription download can start. */}
    <MountOnce when={settingsOpen}>
    <SettingsPage
      open={settingsOpen}
      onClose={closeSettings}
      initialTab={settingsTab}
      // Every project, not the active space's: this is where a project is filed
      // into one, and a list narrowed by the space would hide exactly the rows
      // somebody opens it to move.
      projects={projects}
      spaces={spaces}
      startNamingSpace={namingSpace}
      onSetProjectSpace={setProjectSpace}
      onSetProjectLinearWorkspace={setProjectLinearWorkspace}
      onClearProjectLinearFilter={(path) => setProjectLinearFilter(path, null)}
      onRemoveProject={handleRemoveProject}
      onCreateSpace={createSpace}
      onRenameSpace={renameSpace}
      onRemoveSpace={removeSpace}
      onMoveSpace={moveSpaceBy}
      onMoveProject={moveProject}
      autoHideSidebar={autoHideSidebar}
      onAutoHideSidebarChange={setAutoHideSidebar}
      autoHidePanel={autoHidePanel}
      onAutoHidePanelChange={setAutoHidePanel}
      panelSide={panelSide}
      onPanelSideChange={setPanelSide}
      integrations={integrations}
      updateStatus={updateStatus}
      updateManual={updateManual}
      updateBlocked={anyRunning}
      onCheckUpdates={checkForUpdates}
      onInstallUpdate={installUpdate}
      updateChannel={updateChannel}
      onUpdateChannelChange={setUpdateChannel}
      // Where the Accounts tab runs its probes and opens its terminal: the
      // selected session's directory, the picked project otherwise. Empty is
      // ordinary — a new task has no session yet.
      cwd={composerCwd ?? ""}
    />
    </MountOnce>
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
