import { lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { invoke, listen, LOCAL, serverOfPath, serverOfSession } from "@/lib/transport";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { CircleDashed, Plus } from "lucide-react";
import PrStateIcon from "@/components/PrStateIcon";

import { Button } from "@/components/ui/button";

import "./App.css";
import Chat from "@/components/Chat";
import ChatInput from "@/components/ChatInput";
import DiffWorkerPool from "@/components/DiffWorkerPool";
import NoticeStack from "@/components/NoticeStack";
import BreakOverlay from "@/components/BreakOverlay";
import { useBreakDue } from "@/lib/breaks";
import { askToFixConflicts } from "@/lib/fixConflicts";
import LinkDialog from "@/components/chat/LinkDialog";
import QuitDialog from "@/components/QuitDialog";
import type { SettingsTab } from "@/components/SettingsPage";
import WorktreeDialog, { type WorktreePrompt } from "@/components/WorktreeDialog";
import { useInstallWithServers } from "@/components/ServerUpdateDialog";
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
  activateTab,
  clearOpenError,
  closeTab,
  describePick,
  recordedTab,
  navigate,
  openInBrowser,
  reachableUrl,
  setPendingTab,
  trackBrowserOpen,
  closeBlankTab,
  useBlankTabs,
  setPickHandler,
  useBrowserTabs,
} from "@/lib/browser";
import { setLinkOpener } from "@/lib/openLink";
import { repoChanged } from "@/lib/prSync";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useChanges } from "@/hooks/useChanges";
import { usePrMarks } from "@/hooks/usePrMarks";
import { usePrReady } from "@/hooks/usePrReady";
import { useAutoMergeCards } from "@/hooks/useAutoMergeCards";
import { useWorkStatus } from "@/hooks/useWorkStatus";
import HandoffRow from "@/components/composer/HandoffRow";
import { trackFeature } from "@/lib/analytics";
import { handoffActions } from "@/lib/handoff";
import { prTabVisible, usePullRequest } from "@/hooks/usePullRequest";
import RightPanel, {
  MountOnce,
  PANEL_MIN,
  PanelActions,
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
  SettingsButton,
  SidebarToggle,
  SpaceSwitcher,
  filterSessions,
  placeDrafts,
  sessionUnits,
  sortSessions,
} from "@/components/Sidebar";
import { useChord } from "@/hooks/useShortcuts";
import { type Chord, formatChords } from "@/lib/shortcuts";
import Crew, { CREW_BESIDE, CREW_STACK_WITH_PANEL_W, CREW_W } from "@/components/Crew";
import TasksPanel from "@/components/TasksPanel";
import StalledTasks from "@/components/chat/StalledTasks";
import { MergeCardHostContext, type MergeCardHost } from "@/components/chat/MergeCard";
import { cardRepos } from "@/lib/mergeCard";
import BotWelcome from "@/components/chat/BotWelcome";
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
import { HAS_DICTATION, IS_MAC } from "@/lib/platform";
import AppShell from "@/components/layout/AppShell";
import WindowControls from "@/components/layout/WindowControls";
import { offersFast } from "@/lib/fastMode";
import { lockedMidTurn } from "@/lib/liveControls";
import { nextEffort } from "@/components/composer/ModelSelector";
import { AGENT_LABELS, HARNESS_ORDER, nextHarness } from "@/lib/model";
import { cycledModels } from "@/lib/starredModels";
import ViewTabs, { closeActiveTab, ItemTab, type ViewTab } from "@/components/layout/ViewTabs";
import ShortcutKeys from "@/components/ShortcutKeys";
import { TooltipProvider } from "@/components/ui/tooltip";
import { attachmentKey, clearAttachments, pickAttachments, restoreAttachments } from "@/hooks/useAttachments";
import { useCodeTheme } from "@/hooks/useCodeTheme";
import { refreshActiveDoc, saveActiveDoc, useDocs } from "@/hooks/useDocs";
import {
  closeFile,
  forgetOpenFiles,
  forgetOpenFilesUnder,
  openFilesFor,
  useOpenFiles,
} from "@/hooks/useOpenFiles";
import BotAvatar from "@/components/BotAvatar";
import Orb from "@/components/Orb";
import PickTarget, { type PickOption } from "@/components/PickTarget";
import { seededAvatar } from "@/lib/botAvatar";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useGlass } from "@/hooks/useGlass";
import { warmHighlighter } from "@/hooks/useHighlighter";
import {
  hotkeysSuspended,
  setHotkeysSuspended,
  useDigitHotkey,
  useHotkey,
} from "@/hooks/useHotkey";
import { stepZoom } from "@/lib/zoom";
import { cycleTheme, toggleMode } from "@/hooks/useTheme";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import {
  digitSlot,
  heldMods,
  jumpBadges,
  modsFor,
  registryHolder,
  sameMods,
  showJumpBadges,
} from "@/lib/digitChords";
import { dismissNotice, getNotices, pushNotice } from "@/hooks/useNotices";
import { checkChangelog, markChangelogSeen, type Release } from "@/lib/changelog";
import WhatsNewCard from "@/components/WhatsNewCard";
import { useIntegrations } from "@/hooks/useIntegrations";
import { useSessionIssues } from "@/hooks/useIssues";
import { useSessions } from "@/hooks/useSessions";
import { useAgentAvailability, useMissingAgent } from "@/hooks/useAgentAvailability";
import AgentMissingNotice from "@/components/composer/AgentMissingNotice";
import ServerOfflineNotice from "@/components/composer/ServerOfflineNotice";
import BoatNotice from "@/components/composer/BoatNotice";
import BoatWarnings from "@/components/BoatWarnings";
import { boatAsleep, restoreHeld } from "@/lib/boat";
import TranscriptSkeleton from "@/components/chat/TranscriptSkeleton";
import { checkoutsOf, groupProjects, keyOfPath, lastUsedCheckout, nextCheckout } from "@/lib/projectGroups";
import { serverConnected, serverName, useServers } from "@/lib/servers";
import { canTagFrom } from "@/lib/sessionTag";
import { useReachableSessions } from "@/hooks/useReachableSessions";
import AgentUpdateLine from "@/components/composer/AgentUpdateLine";
import { useAgentUpdates, useAutoUpdateAgents } from "@/hooks/useAgentUpdates";
import { overwritesInPlace, turnRunningOn } from "@/lib/agentUpdates";
import LoginExpiredNotice from "@/components/composer/LoginExpiredNotice";
import AutoContinueNotice from "@/components/composer/AutoContinueNotice";
import type { Attachment, Bot, BotPreview, Harness, IssueRef, MergeMethod, SessionIndexItem, SessionSnapshot, WorktreeDisposition } from "@/types/events";
import { useSlashCommands } from "@/hooks/useSlashCommands";
import { useRecorder } from "@/hooks/useTranscription";
import { useUpdater } from "@/hooks/useUpdater";
import { appendToDraft, onDraftWrite, readDraft, writeDraft } from "@/hooks/useDraft";
import { draftKey, useDrafts } from "@/hooks/useDrafts";
import { issueTag, rememberIssueTitle, setIssueOpener } from "@/lib/issue";
import { authFailedTurn } from "@/lib/auth";
import { basename } from "@/lib/format";
import { focusComposer, focusComposerEnd } from "@/lib/composerFocus";
import { changeRange, lastToolResult } from "@/lib/changes";
import { usePlan } from "@/lib/plan";
import { currentTodos, startsNewList, type Todo } from "@/lib/todos";
import { prBadgeCount, sessionBranch } from "@/lib/pr";
import { botAt, botBrowser, botChat, botEntries, botSession, inBotTree, listenForBots, readPreviews, refreshBots, serverOfBot, useBots } from "@/lib/bots";
import NewBotDialog from "@/components/NewBotDialog";
import AgentIcon from "@/components/AgentIcon";
import ModelSelector from "@/components/composer/ModelSelector";
import { botStance } from "@/lib/permission";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { crewRows, crewSeen, inSidebar, withHiddenAsks, type CrewRow } from "@/lib/crew";
import type { Stall } from "@/lib/stalled";
import { useStalledTasks } from "@/hooks/useStalledTasks";
import {
  addPickTab,
  closePickTab,
  closePicksOn,
  closeTaskTab,
  newestSession,
  openTaskTab,
  pickFilesKey,
  repickTab,
  rowBotOf,
  stripOf,
  type PickTab,
  type PickTabs,
  type TaskTabs,
} from "@/lib/taskTabs";
import { panelMove } from "@/lib/sidebarAuto";
import { playCelebration, playNotification } from "@/lib/sound";
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
import { useHandoffConfig } from "@/hooks/useHandoffConfig";
import { buildTranscript, sessionMedia } from "@/lib/transcript";
import { cn } from "@/lib/utils";
import { playSwipeTick } from "@/lib/tick";

/// Commits only with its Suspense siblings, so its layout effect says the lazy
/// settings page is drawn, before paint.
function SettingsReady({ onReady }: { onReady: (ready: boolean) => void }) {
  useLayoutEffect(() => onReady(true), [onReady]);
  return null;
}

const NO_STALLS: Stall[] = [];

function App() {
  const {
    selectedSessionId,
    selectedSession,
    sessions,
    sessionIndexItems,
    statusBySession,
    unreadWorking,
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
    handleNewBotSession,
    restoreDraftControls,
    markSessionUnread,
    setSessionFlags,
    forkSession,
    unlinkIssue,
    detachSession,
    deleteSession,
    removeWorktree,
    ensureLoaded,
    setNeighbours,
    dropNeighbours,
    setOnScreen,
    setCrewSeen,
    paneState,
    indexSide,
    activeServer,
    botServer,
    setBotServer,
    tasksBySession,
  } = useSessions();

  // Tasks saved to start later. One is open while the new-task composer shows
  // it: its text sits under `draftKey(id)` rather than the new-task key, and
  // edits to the text and the picks save back as they happen.
  const {
    drafts,
    save: saveDraft,
    update: updateDraft,
    remove: removeDraft,
    get: getDraft,
    discardIfEmpty,
  } = useDrafts((e) => setError(String(e)));
  const [openDraftId, setOpenDraftId] = useState<string | null>(null);
  // The sidebar's third view beside active and settled, in memory only.
  const [draftsShown, setDraftsShown] = useState(false);
  // Read from the text listener, which registers once, and written ahead of
  // state on send — see `sendFromComposer`.
  const openDraftRef = useRef(openDraftId);
  openDraftRef.current = openDraftId;
  useEffect(() => {
    if (selectedSessionId) setOpenDraftId(null);
  }, [selectedSessionId]);
  // Dray Island opens on this session when tapped over Dray's window.
  useEffect(() => {
    void invoke("set_app_selection", { sessionId: selectedSessionId }).catch(() => {});
  }, [selectedSessionId]);
  // `dray draft rm` or `start` can take the open draft away; leave it then.
  useEffect(() => {
    if (openDraftId && !drafts.some((d) => d.id === openDraftId)) setOpenDraftId(null);
  }, [drafts, openDraftId]);
  const composerKey = selectedSessionId ?? (openDraftId ? draftKey(openDraftId) : null);

  useEffect(
    () =>
      onDraftWrite(() => {
        const id = openDraftRef.current;
        if (id) updateDraft(id, { prompt: readDraft(draftKey(id)) });
      }),
    [updateDraft],
  );
  useEffect(() => {
    if (!openDraftId || !projectPath) return;
    updateDraft(openDraftId, {
      harness,
      model: modelId,
      effort,
      permissionMode,
      fast,
      useWorktree,
      projectPath,
    });
  }, [openDraftId, harness, modelId, effort, permissionMode, fast, useWorktree, projectPath, updateDraft]);

  // A draft emptied and then left says nothing, so it goes rather than sitting
  // in the list as an empty row. Every way out lands here, since each one
  // moves `openDraftId`.
  const leftDraft = useRef(openDraftId);
  useEffect(() => {
    const left = leftDraft.current;
    leftDraft.current = openDraftId;
    if (left && left !== openDraftId) discardIfEmpty(left);
  }, [openDraftId, discardIfEmpty]);

  /// The composer's send. On an open draft the draft is closed *before* the
  /// send, since the composer clears its text straight after handing it over
  /// and that clear would otherwise be saved as the draft's prompt. It goes
  /// once a session exists, and comes back open if none was made.
  const sendFromComposer = async (message: string, attachments: Attachment[]) => {
    // A new task in a project other than the filtered one would land outside
    // the list it was started from, so the filter follows it. All Projects
    // already shows it and stays.
    if (
      !selectedSessionId &&
      projectFilter &&
      projectPath &&
      !sameProject(projectPath, projectFilter) &&
      spaceProjects.some((p) => p.path === projectPath)
    ) {
      filterSelection.current[projectFilter] = null;
      filterGen.current++;
      setProjectFilter(projectPath);
    }
    const id = openDraftRef.current;
    if (!id || selectedSessionId) {
      const trayKey = attachmentKey(selectedSessionId, composerCwd);
      const sending = handleSendMsg(message, attachments);
      const nav = navGen.current;
      // The composer cleared both on handing them over, and a failed upload
      // is no reason to type the message or pick the files again.
      if (!(await sending) && nav === navGen.current) {
        if (!readDraft(selectedSessionId)) writeDraft(selectedSessionId, message);
        restoreAttachments(trayKey, attachments);
      }
      return;
    }
    const prompt = getDraft(id)?.prompt ?? message;
    const base = getDraft(id)?.base ?? null;
    openDraftRef.current = null;
    // A send is not leaving: an attachment-only prompt has no text, and the
    // empty-draft sweep would delete a draft whose send may yet fail.
    leftDraft.current = null;
    setOpenDraftId(null);
    const sending = handleSendMsg(message, attachments, base);
    // Taken after the send's own bump, so only a move the reader makes while
    // it is out counts as leaving.
    const nav = navGen.current;
    if (await sending) {
      removeDraft(id);
      writeDraft(draftKey(id), "");
    } else if (nav === navGen.current) {
      // The composer cleared both on handing them over.
      writeDraft(draftKey(id), prompt);
      restoreAttachments(draftKey(id), attachments);
      setOpenDraftId(id);
    }
  };

  // ⌘S inside a draft has nothing to do, so the "Changes auto-saved" hint
  // lights up for a moment to say why.
  const [draftNudge, setDraftNudge] = useState(false);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /// ⌘S on any composer: its text and picks become a draft in the sidebar, and
  /// the composer empties for the next task. From a session the draft is a new
  /// task on that session's settings — the picks already mirror it — started
  /// from the default branch like any other, never from the session's work.
  const saveAsDraft = async () => {
    if (openDraftId) {
      setDraftNudge(true);
      clearTimeout(nudgeTimer.current);
      nudgeTimer.current = setTimeout(() => setDraftNudge(false), 2500);
      return;
    }
    const key = selectedSessionId;
    const source = key ? sessionIndexItems.find((i) => i.sessionId === key) : null;
    if (key && !source) return;
    const prompt = readDraft(key);
    const draftProject = source ? source.projectPath : projectPath;
    if (!draftProject || !prompt.trim()) return;
    const id = crypto.randomUUID();
    const saved = await saveDraft({
      id,
      prompt,
      projectPath: draftProject,
      harness,
      model: modelId,
      effort,
      permissionMode,
      fast,
      useWorktree: source ? !!source.worktreeName || source.worktreeRemoved : useWorktree,
      created: new Date().toISOString(),
    });
    if (!saved) return;
    // Only what was saved leaves: text typed while the write was out stays.
    const now = readDraft(key);
    writeDraft(key, now.startsWith(prompt) ? now.slice(prompt.length) : now);
    pushNotice({ sessionId: id, kind: "draft-saved", label: "Saved as draft" });
    playNotification();
  };
  const draftChord = useChord("composer.draft");

  // Whether the agent the composer is pointed at can actually be run. Null
  // while the first read is out and null when it is installed — both mean
  // there is nothing to say, so the composer sends as it always did.
  const missingAgent = useMissingAgent(harness, activeServer);
  // The open session's server, while it cannot be reached. Shown in place of
  // the error a read or send would raise, and cleared by the reconnect itself.
  const allServers = useServers();
  const offlineServer = allServers.find(
    (s) => !!selectedSessionId && s.id === activeServer && s.status !== "connected",
  );
  // Stopped or waking, which a send can do something about, unlike offline.
  const sleepingBoat = allServers.find((s) => s.id === activeServer && boatAsleep(s));
  useEffect(restoreHeld, []);
  // A turn or a background task on that server, which auto-extend keeps alive.
  // Read off the live maps, which hold every session whatever the sidebar
  // shows: the index list is one side of the archived split at a time. Its own
  // status counts only where no live one has arrived yet, since a turn ending
  // moves the live map and leaves the list's copy saying in progress.
  const boatBusy = useCallback(
    (server: string) => {
      const here = (id: string) => serverOfSession(id) === server;
      return (
        Object.entries(statusBySession).some(([id, s]) => s === "in_progress" && here(id)) ||
        Object.entries(tasksBySession).some(([id, tasks]) => tasks.length > 0 && here(id)) ||
        sessionIndexItems.some(
          (i) => !(i.sessionId in statusBySession) && i.status === "in_progress" && serverOfPath(i.cwd) === server,
        )
      );
    },
    [sessionIndexItems, statusBySession, tasksBySession],
  );
  // Only pi and fx, whose update overwrites files a child reads. The other three
  // install beside the running binary, and an update can land at any moment, so
  // holding Send for them blocks the reader to save one old-version session.
  // Keyed on the running update alone, never on the update list, which a
  // check landing mid-update may already have cleared.
  const agentUpdates = useAgentUpdates();
  const agentLabel = useAgentAvailability(activeServer)?.find((a) => a.harness === harness)?.label ?? harness;
  const sendHeld =
    agentUpdates.running === harness &&
    activeServer === LOCAL &&
    overwritesInPlace(harness)
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
  const agents = useAgentAvailability(activeServer);
  const loggedOutAgent =
    authTurn && authTurn !== loginHandled
      ? (agents?.find((agent) => agent.harness === harness) ?? null)
      : null;

  const [collapsed, setCollapsed] = useLocalStorage("ade.sidebarCollapsed", false);
  // The Browser view takes the right pane with it and gives it back on the way
  // out, since a page is somebody else's content and wants the width. The
  // sidebar is never taken: pages are tabs of the titlebar now, flipped as
  // often as any other, and a sidebar that came and went with them jumped.
  const [autoHidePanel, setAutoHidePanel] = useLocalStorage("ade.autoHidePanelInBrowser", true);
  // Owned here for the same reason: `RightPanel`, the shell and the settings
  // row all read it.
  const [panelSide, setPanelSide] = useLocalStorage<PanelSide>("ade.panelSide", "right");
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
  const sameProject = (a: string, b: string) => a === b || keyOfPath(projects, a) === keyOfPath(projects, b);
  /// Points the composer at a project, on the machine it last ran on.
  const selectLastUsed = (path: string) => {
    const checkouts = checkoutsOf(spaceProjects, path);
    handleSelectProject(checkouts.length ? lastUsedCheckout(checkouts).path : path);
  };
  const {
    status: updateStatus,
    manual: updateManual,
    install: installAppUpdate,
    checkNow: checkForUpdates,
    channel: updateChannel,
    setChannel: setUpdateChannel,
  } = useUpdater();
  const { request: installUpdate, dialog: serverUpdateDialog } = useInstallWithServers(updateChannel, installAppUpdate);

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
  // A bot's tasks open as tabs in its row, and the bot a task tab was last
  // picked from — see `stripOf`. Both by bot id. In memory, like `viewTabs`.
  const [taskTabs, setTaskTabs] = useState<TaskTabs>({});
  const [taskTabVia, setTaskTabVia] = useState<string | null>(null);
  // A bot's Diff and Files tabs, each on a session it picked (#892), and
  // which one is on screen while its chat's view is `pick`. By bot id, like
  // `taskTabs`; a target equal to the bot id is the bot's own folder.
  const [pickTabs, setPickTabs] = useState<PickTabs>({});
  const [pickLit, setPickLit] = useState<Record<string, string>>({});
  const pickSeen = useRef(new Map<string, SessionIndexItem>());
  const bots = useBots();
  /// A bot's current chat session: its newest, since an agent switch starts one.
  const chatOfBot = useCallback(
    (id: string) => {
      const bot = bots.find((b) => b.id === id);
      return bot && botSession(sessionIndexItems, bot)?.sessionId;
    },
    [bots, sessionIndexItems],
  );
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

  const storedViewTab: ViewTab = selectedSessionId ? viewTabs[selectedSessionId] ?? "chat" : "chat";
  const selectedBotId = botAt(bots, sessionIndexItems.find((i) => i.sessionId === selectedSessionId)?.cwd ?? "")?.id;
  const litPick =
    storedViewTab === "pick" && selectedBotId
      ? pickTabs[selectedBotId]?.find((t) => t.id === pickLit[selectedBotId])
      : undefined;
  // A pick closed while it was on screen leaves its session on Chat.
  const viewTab: ViewTab = storedViewTab === "pick" && !litPick ? "chat" : storedViewTab;

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
  const integrations = useIntegrations(true);
  // Either one is enough to draw the page and open the picker: the two are
  // alternatives rather than halves of one connection, and a reader with only
  // `gh` signed in has issues to read.
  const issuesConnected = integrations.connected.linear || integrations.connected.github;

  // Not persisted: settings are opened to change something and closed again, so
  // reopening the app into them would be the app remembering the wrong half of
  // a session.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The shell hides only once the lazy page has committed (`SettingsReady`
  // shares its Suspense boundary), or a first open drew a frame of bare window.
  // Mounted closed on idle, it is already resolved when wanted, so the open is
  // instant rather than a beat late; closed it draws nothing.
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsWarm, setSettingsWarm] = useState(false);
  useEffect(() => {
    const warm = () => setSettingsWarm(true);
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(warm);
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 2000);
    return () => clearTimeout(id);
  }, []);
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
  const openChangelog = useCallback(() => {
    setSettingsTab("changelog");
    setSettingsOpen(true);
  }, []);
  // Once a launch: a release flagged `notify` that the reader runs and has not
  // dismissed yet gets the what's-new card.
  const [whatsNew, setWhatsNew] = useState<{ release: Release; seen: string } | null>(null);
  useEffect(() => {
    checkChangelog().then(setWhatsNew, () => {});
  }, []);
  const closeWhatsNew = (view: boolean) => {
    if (whatsNew) markChangelogSeen(whatsNew.seen);
    setWhatsNew(null);
    if (view) openChangelog();
  };
  // Layout, not ordinary: the switch must be down before the page paints, or a
  // keystroke in that frame reaches a shell nobody can see.
  const breakDue = useBreakDue();
  useLayoutEffect(() => setHotkeysSuspended(settingsOpen || breakDue), [settingsOpen, breakDue]);

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
    target: composerKey,
    onText: (text, session) => {
      appendToDraft(session, text);
      // Straight back to typing: the words landed in a draft the reader is
      // most likely about to add to or send. Only where they are still looking
      // at the session they spoke into — a dictation outlives the screen it
      // began on, and focusing a composer holding somebody else's draft is
      // worse than not focusing at all.
      if (session === composerKey) focusComposer();
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
  // On for a remote session too: mic, model and transcription all run on this
  // machine, and the words land in a local draft.
  useHotkey("dictate", () => void recorder.toggle(), { platformOnly: true, enabled: HAS_DICTATION });

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

  // A bot's folder is a git repository only for its own history, which Dray
  // commits — so no Commit button, no branch and no pull request lookup.
  const inBotFolder = !!selectedSession && !!botAt(bots, selectedSession.cwd);

  // What the composer's handoff row draws itself from, and — one line down —
  // which branch the pull requests are looked up by. Read on the same falling
  // edge as those, since a turn is what moves all of it.
  const { status: workStatus, refresh: refreshWorkStatus } = useWorkStatus(
    inBotFolder ? "" : selectedSession?.cwd ?? "",
    busy,
  );
  const handoffConfig = useHandoffConfig();

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
          (!projectFilter || sameProject(i.projectPath, projectFilter)),
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
  // A bot's row is one arrangement too (#881): its chat and every task open
  // in it share one pane, open flag and tab pick alike, so the pane stays put
  // across the row and shows whatever tab is lit. A pick the lit session does
  // not draw falls back to its default, as anywhere — see `activeTab`.
  const rowOf = useCallback(
    (id: string) => {
      const bot = rowBotOf(taskTabs, id, taskTabVia);
      return (bot && chatOfBot(bot)) || id;
    },
    [taskTabs, taskTabVia, chatOfBot],
  );
  const openKey = useCallback(
    (id: string) => {
      const group = groupOf(spaceGroups, id);
      return group ? `group:${group.id}` : rowOf(id);
    },
    [spaceGroups, rowOf],
  );
  useEffect(() => {
    if (!activeGroup || !selectedSessionId) return;
    const key = `group:${activeGroup.id}`;
    setPanelOpens((prev) =>
      key in prev ? prev : { ...prev, [key]: prev[selectedSessionId] ?? false },
    );
  }, [activeGroup, selectedSessionId]);
  const panelTab = selectedSessionId ? (panelTabs[rowOf(selectedSessionId)] ?? null) : null;
  // Both take the session because one caller opens a session and its pane in
  // the same breath, before the selection has moved.
  const setPanelTab = useCallback(
    (tab: PanelTab | null, id = selectedSessionId) => {
      if (id) setPanelTabs((prev) => ({ ...prev, [rowOf(id)]: tab }));
    },
    [selectedSessionId, rowOf],
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
  // A bot's chat is titled with the bot's name, so "<bot> / <title>" says it twice.
  const withProject = (s: SessionIndexItem, project: string) =>
    botAt(bots, s.cwd)?.name ?? `${project} / ${s.title}`;

  const splitTarget = (() => {
    if (!activeGroup || !selectedSession) return null;
    const projects = new Set(paneColumns.flat().map((i) => i.projectPath));
    const named =
      projects.size > 1
        ? withProject(selectedSession, basename(selectedSession.projectPath))
        : selectedSession.title;
    const server = serverOfPath(selectedSession.projectPath);
    return server === LOCAL ? named : `${named} · ${serverName(server)}`;
  })();

  // **Whose preference the right pane follows.** A split group is one
  // arrangement and answers under the group's id; a lone session under its own.
  const panelKey = selectedSessionId && openKey(selectedSessionId);
  // The bare session id stands in for a group key the seeding effect below has
  // not filled yet, or a session reads shut for the commit before it lands.
  const panelOpen = panelKey
    ? (panelOpens[panelKey] ?? (selectedSessionId ? panelOpens[selectedSessionId] : undefined) ?? false)
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
        // Both keys, as the note above promises: written to the group's alone,
        // the pane snapped back to its pre-group state when the group dissolved.
        const session = id ?? selectedSessionId;
        return session ? { ...prev, [key]: next, [session]: next } : { ...prev, [key]: next };
      });
    },
    [panelKey, openKey, selectedSessionId],
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

  const selectedBot = useMemo(() => {
    // The held transcript answers too: a session an agent switch just started
    // reaches the index only once the send returns, and the chat must stay a
    // bot's chat for that while.
    const cwd = sessionIndexItems.find((i) => i.sessionId === selectedSessionId)?.cwd ?? selectedSession?.cwd;
    return cwd ? botAt(bots, cwd) : undefined;
  }, [bots, sessionIndexItems, selectedSessionId, selectedSession?.cwd]);

  // A bot chat's sessions from before the selected one: each agent switch
  // started a new one, and the chat draws them all as one conversation. A
  // selected session not on the index yet is the newest, just started.
  const earlierIds = useMemo(() => {
    if (!selectedBot) return [];
    const chat = botChat(sessionIndexItems, selectedBot).map((i) => i.sessionId);
    const at = chat.indexOf(selectedSessionId ?? "");
    return at >= 0 ? chat.slice(0, at) : chat;
  }, [selectedBot, sessionIndexItems, selectedSessionId]);

  // Every session the selected one started, at any depth. The crew column
  // draws only the ones holding a card, and only while one is; a bot's Tasks
  // tab lists them all, its earlier sessions' tasks included. Off every held
  // session, not the space's: a bot hands work to whichever project it likes,
  // in any space.
  const crew = useMemo(
    () => crewRows(sessionIndexItems, selectedSessionId, { statusBySession, askingSessions, tasksBySession }, earlierIds),
    [sessionIndexItems, selectedSessionId, statusBySession, askingSessions, tasksBySession, earlierIds],
  );
  const crewAsks = useMemo(() => crew.filter((r) => r.asking), [crew]);
  // A split has no crew column: it is already several conversations side by
  // side, with nowhere for one to go. Its children's cards raise notices.
  const crewAvailable = crew.length > 0 && !activeGroup && !issuesOpen && viewTab === "chat";
  const crewDrawn = crewAvailable && crewAsks.length > 0;
  // **Beside the chat only where it fits, judged on minimums alone.** The
  // column never gives width back, so on a narrow window it crushed the
  // sidebar to a sliver. Measured off the sidebar's *drawn* width this would
  // chase itself — the column's floor is what clamps that width — so it reads
  // the floor, and where it does not fit the cards stack above the composer.
  // Up to a 14" MacBook's width, an open panel stacks it even where the
  // minimums fit: all four at their floors reads as cramped, not as fitting.
  const sidebarW = Math.max(SIDEBAR_MIN, usePaneWidth("sidebar"));
  // What the sidebar is drawn at, 0 while shut: where the sheet starts.
  const sidebarDrawn = usePaneWidth("sidebar");
  const viewportW = useViewportWidth();
  const crewFits =
    viewportW >= CHAT_MIN + CREW_W + (collapsed ? 0 : sidebarW) + (panelShown ? PANEL_MIN : 0);
  const crewBeside =
    CREW_BESIDE && crewFits && !(panelShown && viewportW <= CREW_STACK_WITH_PANEL_W);
  // One conversation keeps a readable floor whatever the panes beside it are
  // dragged to; a split holds several deliberately small ones, so the same
  // floor there would refuse the layout the reader asked for. The crew column
  // rides on top of it because it is fixed-width and never gives any back.
  const mainGroup = activeGroup;
  useChatColumnFloor(!mainGroup, crewDrawn && crewBeside ? CREW_W : 0);

  // The composer says where it sends whenever that is not the transcript
  // under it — a grid's focused pane. One box under several conversations is
  // one box that can send into the wrong one, so it says which first.
  const composerTarget = (mainGroup && splitTarget) ?? null;

  // A card is read out of its session's own events, so an asking row has to be
  // loaded. Gated on the column being *drawn*, since being on screen is what
  // read-marking promises.
  const crewShown = (crewDrawn ? crewAsks : []).map((row) => row.item.sessionId).join("\n");

  // Every pane loaded and held: eviction and read-marking treat the whole grid
  // as on screen. One effect for the grid and the crew together, since
  // `setOnScreen` takes the whole set rather than adding to it — two callers
  // would each wipe the other's.
  // A bot chat's earlier sessions are drawn with it, so they are on screen too.
  const onScreenKey = [mainGroup ? memberKey : earlierIds.join("\n"), crewShown].filter(Boolean).join("\n");
  useEffect(() => {
    const ids = [...new Set(onScreenKey.split("\n").filter(Boolean))];
    setOnScreen(ids);
    ids.forEach((id) => void ensureLoaded(id));
    // Both are rebuilt every render; the key is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScreenKey]);

  // Every row the column would draw a card for, for `announce` alone — see
  // `crewSeen`. Wider than `crewShown` on purpose: that one loads and
  // read-marks, where this one answers whether a card would land in front of
  // the reader.
  //
  // **A layout effect, not an ordinary one, because a stale reading here
  // suppresses a notice.** After paint, a column flipped behind another view
  // tab would go on naming its rows for a frame and silence an ask with
  // nothing on screen; a render-time write could describe a render React threw
  // away. A layout effect publishes exactly what was committed, before paint.
  const crewSeenKey = crewSeen(crew, crewAvailable).join("\n");
  useLayoutEffect(() => {
    setCrewSeen(crewSeenKey.split("\n").filter(Boolean));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crewSeenKey]);

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
  // Every server's list is first read with its projects, in `readServer`.
  useEffect(() => listenForBots(), []);
  const searchedSessions = useMemo(
    () => filterSessions(inSidebar(visibleSessions, bots), search),
    [visibleSessions, bots, search],
  );
  // Off every session held, not the space-filtered list: a bot is no project and
  // belongs to no space, so filtering would hide its chat and open a new one.
  // Chatless while the settled side is loaded: the active chat is not in it, so
  // an entry built there would open a second one — `openBot` switches back first.
  const botChats = useMemo(
    () => botEntries(bots, archivedShown ? [] : sessionIndexItems).flatMap((b) => (b.session ? [b.session] : [])),
    [archivedShown, bots, sessionIndexItems],
  );
  // Each chat's last reply, read off the end of its log rather than loading the
  // transcript. Read again whenever a chat's status or last activity moves.
  const [botPreviews, setBotPreviews] = useState<Record<string, BotPreview>>({});
  const previewKey = botChats
    .map((c) => `${c.sessionId}:${statusBySession[c.sessionId] ?? c.status}:${c.modified}`)
    .join("|");
  useEffect(() => {
    const sessionIds = botChats.map((c) => c.sessionId);
    if (sessionIds.length === 0) return;
    void readPreviews(sessionIds).then(setBotPreviews);
    // The key carries everything that moves a preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);
  const botList = useMemo(
    () => botEntries(bots, archivedShown ? [] : sessionIndexItems, botPreviews),
    [archivedShown, bots, sessionIndexItems, botPreviews],
  );
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [botToDelete, setBotToDelete] = useState<Bot | null>(null);
  // A bot clicked while the settled list was up, opened once the active side lands.
  const [botWaiting, setBotWaiting] = useState<Bot | null>(null);
  const openBot = (bot: Bot) => {
    if (archivedShown) {
      setShowArchived(false);
      setBotWaiting(bot);
      return;
    }
    const chat = botList.find((b) => b.bot.id === bot.id)?.session;
    // Read before the select: opening the chat marks it read, and the NEW
    // divider has to know it was not.
    setOpenedUnread(
      chat && (statusBySession[chat.sessionId] ?? chat.status) === "completed" ? chat.sessionId : null,
    );
    goToSession(() =>
      chat ? void handleSelectSessionIndexItem(chat.sessionId) : handleNewBotSession(bot.path),
    );
  };
  const [openedUnread, setOpenedUnread] = useState<string | null>(null);
  useEffect(() => {
    if (!botWaiting || archivedShown) return;
    setBotWaiting(null);
    openBot(botWaiting);
    // `openBot` is rebuilt every render; the side landing is what this waits on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botWaiting, archivedShown]);
  // Narrowed the way the sessions above are, so a draft never sits under a
  // project the list is not drawing.
  const sidebarDrafts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return drafts.filter(
      (d) =>
        sessionInSpace(projects, space, d.projectPath) &&
        (!projectFilter || sameProject(d.projectPath, projectFilter)) &&
        d.prompt.toLowerCase().includes(needle),
    );
  }, [drafts, projects, space, projectFilter, search]);
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
  // A bot's tasks run hidden, so their repos are added while their Tasks tab
  // can be on screen: that tab draws their marks.
  // A merge card's task may be settled and out of every list, so the repos the
  // cards on screen name are read too: the open chat's, and every split pane's.
  const cardRepoKey = useMemo(
    () =>
      cardRepos(
        sessions
          .filter(
            (s) =>
              s.sessionId === selectedSessionId ||
              earlierIds.includes(s.sessionId) ||
              memberKey.split("\n").includes(s.sessionId),
          )
          .flatMap((s) => s.events),
      ).join("\n"),
    [sessions, selectedSessionId, earlierIds, memberKey],
  );
  // Every task's too, wherever the reader is, hidden or filtered away: its PR
  // turning ready posts a merge card in the chat that started it, and a bot's
  // stalled task is judged by its PR. A bot's tasks are tasks like any other.
  const botRepoKey = useMemo(
    () =>
      [
        ...new Set(
          sessionIndexItems
            .filter((i) => !i.archived && i.parentSessionId && i.parentSessionId !== i.sessionId)
            .map((i) => i.projectPath),
        ),
      ].join("\n"),
    [sessionIndexItems],
  );
  // Whichever sidebar list is up: a card on screen is still being read.
  const repoPaths = useMemo(
    () => [
      ...new Set([
        ...(archivedShown ? [] : [...visibleSessions, ...crew.map((r) => r.item)].map((i) => i.projectPath)),
        ...(cardRepoKey ? cardRepoKey.split("\n") : []),
        ...(botRepoKey ? botRepoKey.split("\n") : []),
      ]),
    ],
    [archivedShown, visibleSessions, crew, cardRepoKey, botRepoKey],
  );
  const botRepos = useMemo(() => (botRepoKey ? botRepoKey.split("\n") : []), [botRepoKey]);
  const prMarks = usePrMarks(repoPaths, botRepos);

  // "This can land now" — raised off the sidebar's marks rather than the
  // panel's own read, which is the only way it can be noticed at all: the
  // panel's poll is gated on its tab being on screen, and a tab on screen is
  // exactly the case with nothing to announce.
  usePrReady({ sessions: visibleSessions, prFor: prMarks.prFor, canAnnounce });
  // The same marks, turned into a merge card in the chat that started a task,
  // so landing it never waits on an agent remembering to post one.
  useAutoMergeCards({ items: sessionIndexItems, bots, prFor: prMarks.prFor });

  // Each bot's tasks that have sat untouched: drawn at the foot of its chat,
  // and a banner per bot when new ones land while the window is away.
  const taskPr = useCallback(
    (row: CrewRow) => prMarks.prFor(row.item.projectPath, sessionBranch(row.item)),
    [prMarks.prFor],
  );
  const taskPrReadAt = useCallback((row: CrewRow) => prMarks.readAt(row.item.projectPath), [prMarks.readAt]);
  const stalled = useStalledTasks({
    bots,
    items: sessionIndexItems,
    statusBySession,
    askingSessions,
    tasksBySession,
    prOf: taskPr,
    prReadAt: taskPrReadAt,
  });
  const stalls = (selectedBot && stalled.byBot.get(selectedBot.id)?.card) || NO_STALLS;
  // The card's row the reader last picked, which the bot's chat scrolls to.
  // Named with its bot, so another bot's chat never acts on it.
  const [stallFocus, setStallFocus] = useState<{ botId: string; sessionId: string; at: number } | null>(null);
  const botFocus = stallFocus && stallFocus.botId === selectedBot?.id ? stallFocus : null;
  // A pick is honoured once. Kept past leaving its bot, it came back as a new
  // `botFocus` on every return and the chat jumped to it again.
  useEffect(() => {
    setStallFocus((focus) => (focus && focus.botId !== selectedBot?.id ? null : focus));
  }, [selectedBot?.id]);

  // Read here rather than inside the panel: the tab row needs to know whether
  // there is an open PR before that tab has ever been shown, so ordering it
  // first can't wait on the panel fetching for itself.
  //
  // `workStatus.branch` is git's own reading of HEAD and outranks the name the
  // index carries, which is only ever a guess made at creation — see
  // `sessionBranch`. It lands a frame late and the fallback covers that frame.
  const prBranch = selectedSession && !inBotFolder
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
    // No opening the pane when a PR appears: an agent posts a merge card in
    // the chat for that (`dray session merge-card`), and the pane opens by hand.
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
  const { opened: filesOpened, active: activeFile, open: openFiles } = useOpenFiles(selectedSessionId);
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
  const sessionAttachments = useMemo(
    () => sessionMedia(selectedSession?.events ?? []),
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

  // Every session browses in its own browser, a bot's tasks included. A bot
  // chat is the exception only in name: an agent switch makes it several
  // sessions, and its pages live on the oldest, as the server routes them.
  const browserOf = (id: string) => botBrowser(bots, sessionIndexItems, id) ?? id;
  const browserSession = selectedSessionId ? browserOf(selectedSessionId) : null;
  const browserTabs = useBrowserTabs(browserSession);
  const blankTabs = useBlankTabs(browserSession ?? "");
  const pendingBrowserTab = blankTabs.active !== null;
  const hasBrowserTabs = browserTabs && browserTabs.length > 0;
  // A link's tab is answered for before the strip lists it, and the Browser
  // view with no lit tab hands itself back to Chat — so the flip waits for an
  // active tab to be there.
  const [browserWanted, setBrowserWanted] = useState<string | null>(null);
  useEffect(() => {
    if (!browserWanted) return;
    if (browserWanted !== selectedSessionId) return setBrowserWanted(null);
    if (!browserTabs?.some((tab) => tab.active)) return;
    setViewTabs((prev) => ({ ...prev, [browserWanted]: "browser" }));
    setBrowserWanted(null);
  }, [browserWanted, browserTabs, selectedSessionId]);
  // The main column's Browser view is the panel's browser expanded. Arriving
  // on it closes the pane, whatever tab the pane was on: the reader came for
  // the full width. ⌘E brings it back beside the page, and leaving gives back
  // a pane the arrival took — the sidebar's rule, under its own switch.
  const fullBrowserOpen = !issuesOpen && viewTab === "browser";
  const lastViewTab = useRef(viewTab);
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
  }, [viewTab, setPanelOpen, panelOpen, panelKey, autoHidePanel]);
  const expandBrowser = () => setViewTab("browser");
  const collapseBrowser = () => {
    setViewTab("chat");
    showPanel("browser");
  };

  // A live background task counts even where no run is built for it yet, and a
  // task list counts on its own — the tab is a catch-all, so any one of its
  // sections having something is enough to draw it.
  const hasMoreTab =
    subagents.length > 0 ||
    backgroundTasks.length > 0 ||
    sessionTodos !== null ||
    sessionAttachments.length > 0;

  // A task a bot started, named in the bot's chat. Takes an id prefix, as
  // `dray session send` does, so a message the bot sent finds its task.
  const taskOf = useCallback(
    (id: string) => {
      const match = (sessionId: string) => sessionId === id || (id.length >= 8 && sessionId.startsWith(id));
      const item = crew.find((r) => match(r.item.sessionId))?.item ?? sessionIndexItems.find((i) => match(i.sessionId));
      return item && { sessionId: item.sessionId, title: item.title };
    },
    [crew, sessionIndexItems],
  );

  const earlierLoaded = sessions.filter((s) => earlierIds.includes(s.sessionId));
  const earlierKey = earlierLoaded.map((s) => `${s.sessionId}:${s.olderBefore}:${s.events.length}`).join();
  // Loaded and held as on screen (`onScreenKey`), and read further back only
  // as the reader scrolls (`Chat`). Only the run of loaded ones just before the
  // selected session is passed: one still loading would leave a gap the chat
  // could not tell from the conversation.
  const earlier = useMemo(
    () => {
      const run: SessionSnapshot[] = [];
      for (const id of [...earlierIds].reverse()) {
        const held = earlierLoaded.find((s) => s.sessionId === id);
        if (!held) break;
        run.unshift(held);
      }
      return run;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [earlierIds.join(), earlierKey],
  );

  // The bot chat whose row the titlebar draws, and the task lit in it.
  const strip = stripOf(taskTabs, selectedSessionId, selectedBot?.id ?? null, taskTabVia, chatOfBot);
  const stripOwner = strip && strip.owner !== selectedSessionId
    ? sessionIndexItems.find((i) => i.sessionId === strip.owner)
    : undefined;

  // What a bot row's Diff and Files picks choose from: the bot's tasks as the
  // Tasks tab lists them, read off the row's owner rather than the selection,
  // which is a task while a task tab is lit.
  const stripBot = strip ? bots.find((b) => b.id === strip.bot) : undefined;
  const botTasks = useMemo(
    () =>
      strip && stripBot
        ? crewRows(
            sessionIndexItems,
            strip.owner,
            { statusBySession, askingSessions },
            botChat(sessionIndexItems, stripBot)
              .map((i) => i.sessionId)
              .filter((id) => id !== strip.owner),
          )
            .map((r) => r.item)
            .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
        : [],
    [strip?.owner, stripBot, sessionIndexItems, statusBySession, askingSessions],
  );
  // The index lists one side of the sidebar, so a task settled under a pick
  // leaves it while its folder may still be there to show. Each target's
  // entry is kept as last seen, and the lit one is asked for again on every
  // index change, since settling can delete the worktree after it leaves.
  for (const t of Object.values(pickTabs).flat()) {
    const live = sessionIndexItems.find((i) => i.sessionId === t.target);
    if (live) pickSeen.current.set(t.target, live);
  }
  const [pickAsked, setPickAsked] = useState<SessionIndexItem | null>(null);
  const [pickTick, setPickTick] = useState(0);
  const litPickBusy =
    litPick?.kind === "changes" && statusBySession[litPick.target] === "in_progress" && !issuesOpen;
  useEffect(() => {
    if (!litPickBusy) return;
    const t = setInterval(() => setPickTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [litPickBusy]);
  const unlistedPick =
    litPick && litPick.target !== selectedBotId && !sessionIndexItems.some((i) => i.sessionId === litPick.target)
      ? litPick.target
      : null;
  useEffect(() => {
    if (!unlistedPick) return;
    let live = true;
    void invoke<SessionIndexItem | null>("session_index_item", { sessionId: unlistedPick })
      .catch(() => null)
      .then((item) => {
        if (!live || !item) return;
        pickSeen.current.set(unlistedPick, item);
        setPickAsked(item);
      });
    return () => {
      live = false;
    };
  }, [unlistedPick, sessionIndexItems]);
  // The bot's own folder is whichever chat session it has now.
  const pickItem = (target: string) =>
    sessionIndexItems.find((i) => i.sessionId === (target === strip?.bot ? strip.owner : target)) ??
    (pickAsked?.sessionId === target ? pickAsked : undefined) ??
    pickSeen.current.get(target);
  const pickTitle = (target: string) =>
    target === strip?.bot ? (stripBot?.name ?? "Bot") : (pickItem(target)?.title ?? "Task gone");
  const pickFace = (target: string) =>
    target === strip?.bot ? (
      <BotAvatar seed={stripBot?.id ?? target} avatar={stripBot?.avatar} className="block size-4 shrink-0" />
    ) : statusBySession[target] === "in_progress" ? (
      <Orb state="working" label="Working" size={16} />
    ) : (
      <BotAvatar seed={target} avatar={seededAvatar(target)} className="block size-4 shrink-0 scale-[1.18]" />
    );
  /// Puts a pick on screen in its bot's row, stepping out of a lit task tab.
  const showPick = (bot: string, owner: string, id: string) => {
    setPickLit((prev) => ({ ...prev, [bot]: id }));
    setViewTabs((prev) => ({ ...prev, [owner]: "pick" }));
    if (selectedSessionId !== owner) void handleSelectSessionIndexItem(owner);
  };

  const tabs = tabOrder({
    pr: hasPrTab,
    docs: hasDocsTab,
    issue: hasIssueTab,
    more: hasMoreTab,
    plan: hasPlanTab,
    tasks: !!selectedBot,
  });

  // One rule, read rather than written back: an explicit pick wins wherever it
  // still names a tab this session draws, and otherwise the derived default
  // stands in. Not written back, so switching to a session without a PR keeps
  // the reader's pick for when they switch to one that has it.
  const activeTab: PanelTab = panelTab && tabs.includes(panelTab) ? panelTab : selectedBot ? "tasks" : defaultTab;


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
    // A shut pane opens on its first tab, so the chord alone gets the reader
    // moving; ⌘E is what shuts it again.
    if (!panelShown) return issuesOpen || !shownSession ? undefined : showPanel(tabs[0]);
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
  const composerServer = composerProject ? serverOfPath(composerProject) : LOCAL;
  const { reachable: reachableSessions, refresh: refreshReachableSessions } = useReachableSessions(composerServer);
  const connectedServers = useServers();
  // In a bot's chat, `&` offers its own tasks, which run hidden and live in no
  // project the composer is on: every one still active, set-aside ones aside.
  const composerSessions = useMemo(
    () =>
      selectedBot
        ? crew.map((r) => r.item).filter((i) => !i.archived && !i.aside)
        : sessionIndexItems.filter(
        (i) =>
          sessionInSpace(projects, space, i.projectPath) &&
          (!composerProject || sameProject(i.projectPath, composerProject)) &&
          serverConnected(serverOfPath(i.projectPath)) &&
          canTagFrom(composerServer, i.sessionId, i.projectPath, reachableSessions),
      ),
    // `sameProject` follows `projects`, and `serverConnected` follows the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedBot, crew, sessionIndexItems, projects, space, composerProject, composerServer, reachableSessions, connectedServers],
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

  const { baseline, head, previous } = useMemo(
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

  // The same reads, mid-turn, where Claude Code says what moved: an agent that
  // opens a PR and then spends minutes on CI no longer hides it until the turn
  // ends. Marks for any session, since a row's glyph is on screen whichever is
  // selected; the panel and the handoff row for the selected one alone.
  useEffect(
    () =>
      repoChanged.subscribe(({ sessionId, pullRequest }) => {
        if (pullRequest) prMarks.refreshAfterWrite();
        if (sessionId !== selectedSessionId) return;
        refreshWorkStatus();
        if (pullRequest) pullRequests.refresh();
      }),
    [selectedSessionId, prMarks.refreshAfterWrite, pullRequests.refresh, refreshWorkStatus],
  );

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
  // A turn that has written nothing yet shows the last turn that did, so
  // sending a question doesn't blank the diff it is asking about — nor does the
  // turn's end, whose first paint is a live preview that may predate the write.
  // A finished turn not read at all waits instead: standing the previous diff
  // in there would flash a turn the reader didn't ask about on a cold open.
  const currentEmpty = head
    ? changesData.changes?.files.length === 0
    : !changesData.changes?.files.length;
  // Frozen, so this reads once and is cached.
  const previousData = useChanges(
    selectedSession?.cwd ?? "",
    previous?.baseline ?? null,
    previous?.head ?? null,
    turnRevision,
    panelShown && activeTab === "changes" && currentEmpty,
    false,
  );
  // A failed read keeps its own range, so its error isn't hidden.
  const shownChanges =
    previousData.changes && !changesData.error && currentEmpty ? previousData : changesData;

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

  // The PR tab names its pull request, merged too: its glyph, or the
  // checks spinner while they run, and its number. Read off the sidebar's mark,
  // which its own poll keeps current, so this costs no `gh` call; the panel's
  // read polls only while its tab is open. Several live PRs keep the count.
  const prFace =
    markHere && !prBadgeCount(pullRequests.prs)
      ? {
          icon:
            markHere.state === "OPEN" && markHere.checksState === "RUNNING" ? (
              <CircleDashed
                className="size-3.5 shrink-0 animate-spin text-accent-command [animation-duration:3s]"
                strokeWidth={1.5}
                aria-label="Checks running"
              />
            ) : (
              <PrStateIcon pr={markHere} />
            ),
          label: `#${markHere.number}`,
        }
      : null;

  // Same order the sidebar draws, so the walk matches the list even when the
  // sidebar is collapsed and there is nothing on screen to follow — project
  // list included, since that is what orders the groups it steps through.
  const sidebarOrder = useMemo(
    () =>
      sortSessions(
        searchedSessions,
        projects,
        // The same reading the sidebar groups by, and withheld on the same list
        // — the walk has to step the runs the eye is looking at.
        archivedShown ? undefined : { statusBySession, asking: sidebarAsking, prFor: prMarks.prFor },
        archivedShown,
        archivedShown ? [] : spaceGroups,
      ),
    [searchedSessions, projects, archivedShown, statusBySession, sidebarAsking, prMarks.prFor, spaceGroups],
  );
  // What ⌘⇧↑/↓ and the jump digits walk: the bots' chats first, as the sidebar
  // draws them above every project, then the sidebar's own order.
  const ordered = useMemo(
    () => [...botList.flatMap((b) => (b.session ? [b.session] : [])), ...sidebarOrder],
    [botList, sidebarOrder],
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
  const stepTarget = (units: SessionIndexItem[][], delta: number, current: string | null) => {
    if (units.length === 0) return;
    const from = units.findIndex((u) => u.some((i) => i.sessionId === current));
    // No selection is the empty composer — either direction enters at the top.
    const next =
      from === -1
        ? 0
        : delta > 0
          ? (from + 1) % units.length
          : Math.max(from - 1, 0);
    return units[next][0].sessionId;
  };
  // The drafts view's rows, in the order it draws them.
  const draftRows = useMemo(
    () =>
      placeDrafts([], sidebarDrafts, projects).flatMap((run) =>
        run.kind === "drafts" ? run.drafts : [],
      ),
    [sidebarDrafts, projects],
  );
  const stepThrough = (units: SessionIndexItem[][], delta: number) => {
    const id = stepTarget(units, delta, selectedSessionId);
    if (id && id !== selectedSessionId) void handleSelectSessionIndexItem(id);
  };
  // Where ⌘⇧↑/↓ last landed. Neighbours are warmed only while the selection is
  // still there, so a click elsewhere lets them go and a mouse open warms none.
  const [steppedTo, setSteppedTo] = useState<string | null>(null);
  // Set while the step modifiers warmed rows and no arrow has followed yet.
  const armedRef = useRef(false);
  // The walk steps whichever view the sidebar shows.
  const stepRow = (delta: number) => {
    const rows = draftsShown
      ? draftRows.map((d) => ({ id: d.id, draft: true }))
      : ordered.map((i) => ({ id: i.sessionId, draft: false }));
    if (rows.length === 0) return;
    const from = rows.findIndex((r) => r.id === (openDraftId ?? selectedSessionId));
    const target =
      rows[from === -1 ? 0 : delta > 0 ? (from + 1) % rows.length : Math.max(from - 1, 0)];
    if (target.draft) return openDraft(target.id);
    armedRef.current = false;
    setSteppedTo(target.id);
    if (target.id !== selectedSessionId) void handleSelectSessionIndexItem(target.id);
  };
  // After a pause, so a held chord does not read every row it passes. Two
  // presses either way, wrap and top hold included.
  useEffect(() => {
    if (!steppedTo || steppedTo !== selectedSessionId) {
      setNeighbours([]);
      return;
    }
    const timer = setTimeout(() => {
      const at = ordered.findIndex((i) => i.sessionId === steppedTo);
      if (at === -1) return setNeighbours([]);
      setNeighbours(
        [1, 2, -1, -2]
          .map((d) => ordered[d > 0 ? (at + d) % ordered.length : Math.max(at + d, 0)].sessionId)
          .filter((id) => id !== steppedTo),
      );
    }, 150);
    return () => clearTimeout(timer);
    // `setNeighbours` is rebuilt every render; these are what move the set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steppedTo, selectedSessionId, ordered]);
  // Holding the step chords' modifiers is the reader about to walk, so the
  // rows one press away are warmed before the first arrow. Any other key under
  // them was not a walk and drops what was warmed; letting go with no arrow
  // pressed hands them back to the sweep. Skipped mid-walk, where the
  // two-either-way set above already covers it.
  const prevChord = useChord("session.prev");
  const nextChord = useChord("session.next");
  const stepKeysRef = useRef({ arm: () => {}, drop: () => {}, release: () => {} });
  stepKeysRef.current = {
    arm: () => {
      if (draftsShown || ordered.length === 0) return;
      if (steppedTo && steppedTo === selectedSessionId) return;
      const at = ordered.findIndex((i) => i.sessionId === selectedSessionId);
      armedRef.current = true;
      setNeighbours(
        at === -1
          ? [ordered[0].sessionId]
          : [ordered[(at + 1) % ordered.length], ordered[Math.max(at - 1, 0)]]
              .map((i) => i.sessionId)
              .filter((id) => id !== selectedSessionId),
      );
    },
    drop: () => {
      armedRef.current = false;
      setSteppedTo(null);
      dropNeighbours();
    },
    release: () => {
      if (!armedRef.current) return;
      armedRef.current = false;
      setNeighbours([]);
    },
  };
  useEffect(() => {
    const chords = [prevChord, nextChord].filter(
      (c): c is Chord => !!c && (c.meta || c.shift || c.alt),
    );
    if (chords.length === 0) return;
    const modifier = (e: KeyboardEvent) => ["Meta", "Control", "Shift", "Alt"].includes(e.key);
    const holds = (e: KeyboardEvent, c: Chord) =>
      (e.metaKey || e.ctrlKey) === c.meta && e.shiftKey === c.shift && e.altKey === c.alt;
    // `useHotkey`'s own match, so a step it fires is never read as another key.
    const steps = (e: KeyboardEvent, c: Chord) =>
      e.key.toLowerCase() === c.key.toLowerCase()
      || (c.alt && c.key.length === 1 && e.code === `Key${c.key.toUpperCase()}`)
      || (c.code !== undefined && e.code === c.code);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || !chords.some((c) => holds(e, c))) return;
      if (modifier(e)) return stepKeysRef.current.arm();
      if (!chords.some((c) => steps(e, c))) stepKeysRef.current.drop();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (modifier(e)) stepKeysRef.current.release();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [prevChord, nextChord]);
  // Holding the jump modifier numbers the first ten rows; a digit under it
  // selects one. On `window` in the capture phase, ahead of every `useHotkey`:
  // those accept ⌃ as ⌘, so ⌃1 would also flip to the Chat view, and ⌥1 would
  // type "¡" into the composer. Not `useDigitHotkey`, which has no hold.
  const jumpRef = useRef({ rows: (): string[] => [], go: (_id: string) => {} });
  jumpRef.current = {
    rows: () => (draftsShown ? [] : ordered.slice(0, 10).map((i) => i.sessionId)),
    go: (id) =>
      goToSession(() => {
        if (id !== selectedSessionId) void handleSelectSessionIndexItem(id);
      }),
  };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      clearTimeout(timer);
      timer = undefined;
      showJumpBadges(null);
    };
    const modifier = (e: KeyboardEvent) => ["Meta", "Control", "Shift", "Alt"].includes(e.key);
    const onKeyDown = (e: KeyboardEvent) => {
      const mods = modsFor("session.jump");
      if (hotkeysSuspended() || !sameMods(heldMods(e), mods)) return hide();
      const slot = digitSlot(e.code);
      if (slot !== null) {
        if (registryHolder(mods, slot)) return hide();
        e.preventDefault();
        e.stopPropagation();
        // The numbers on screen, not today's order, or a row that moved while
        // the modifier was held opens a session other than the one it wears.
        const id = (jumpBadges() ?? jumpRef.current.rows())[slot];
        hide();
        if (id) jumpRef.current.go(id);
        return;
      }
      if (!modifier(e)) return hide();
      // Long enough that a quick chord never flashes the numbers.
      timer ??= setTimeout(() => showJumpBadges(jumpRef.current.rows()), 300);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (modifier(e)) hide();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    // A modifier released in another app sends no keyup here.
    window.addEventListener("blur", hide);
    return () => {
      hide();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", hide);
    };
  }, []);
  // Headings, not split groups: with no grid on screen the chord used to be
  // ⌘⇧ under another name, stepping one row at a time and never reaching the
  // next project the way its own label promised.
  const units = useMemo(
    () =>
      sessionUnits(
        searchedSessions,
        projects,
        archivedShown ? undefined : { statusBySession, asking: sidebarAsking, prFor: prMarks.prFor },
        archivedShown,
        archivedShown ? [] : spaceGroups,
      ),
    [searchedSessions, projects, archivedShown, statusBySession, sidebarAsking, prMarks.prFor, spaceGroups],
  );
  const stepGroup = (delta: number) => stepThrough(units, delta);

  // A click on a markdown path in the transcript, which is the one route in.
  // Off the counter rather than off `docs.length`, since reopening a file that
  // is already open leaves the list unchanged and still has to bring the pane
  // forward.
  //
  // The pick moves as well as the pane, and has to, for the same reason
  // `usePullRequest`'s `onOpened` writes one: `activeTab` honours a standing
  // pick over the derived default.
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

  // A link in the transcript opens as a new tab in the browser of the chat it
  // was clicked in and flips the main column to the Browser view, leaving the
  // side panel alone. In a bot's row the main column is the row's, so there
  // it opens in the side panel instead, beside that chat — the bot's or the
  // lit task's. ⌘-click, or no session to hold one, goes to the system browser.
  useEffect(() => {
    setLinkOpener((url, { external }) => {
      if (!selectedSessionId || !browserSession) {
        void openUrl(url).catch(console.error);
        return;
      }
      // The session is named outright: the read lands after an await, and by
      // then the reader may be on another session whose pane must stay put.
      const sessionId = selectedSessionId;
      const browser = browserSession;
      const inBotRow = !!selectedBotId || rowOf(sessionId) !== sessionId;
      const gen = navGen.current;
      void reachableUrl(sessionId, url).then(
        (reached) => {
          if (external) return void openUrl(reached).catch(console.error);
          void openInBrowser(browser, reached, true)
            .then(() => {
              if (inBotRow) showPanel("browser", sessionId);
              else setBrowserWanted(sessionId);
              trackBrowserOpen(reached);
            })
            .catch(() => {
              // Answered by the system browser, so the pane has nothing to say.
              clearOpenError(sessionId);
              void openUrl(reached).catch(console.error);
            });
        },
        // A failed forward has no tab to report in, and the raw URL would
        // open this Mac's port instead, so the reason goes to the composer.
        (e: unknown) => {
          if (gen === navGen.current) setError(String(e));
        },
      );
    });
    return () => setLinkOpener(null);
  }, [selectedSessionId, browserSession, selectedBotId, rowOf, showPanel, navGen, setError]);

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
    setOpenDraftId(null);
    go();
  };

  /// The new-task composer, carrying a draft's text and picks.
  const openDraft = (id: string) => {
    const draft = getDraft(id);
    if (!draft) return;
    goToSession(() => {
      restoreDraftControls(draft);
      writeDraft(draftKey(id), draft.prompt);
      setOpenDraftId(id);
    });
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
  /// The session open a run of filter steps is holding back, and the selection
  /// generation it was set under.
  const filterNav = useRef<{ timer: ReturnType<typeof setTimeout>; nav: number } | null>(null);

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
  ///
  /// The list moves at once but the session waits for the clicks to stop:
  /// opening one per step is what lagged a quick run through the projects.
  /// Mid-run the selection still belongs to the filter the run left, so only
  /// the first step records it.
  const changeProjectFilter = (next: string | null) => {
    if (next === projectFilter) return;
    // A selection made since the last step ends the run, so it is kept.
    const run = filterNav.current;
    if (!run || run.nav !== navGen.current) {
      filterSelection.current[projectFilter ?? ""] = selectedSessionId;
    }
    const gen = ++filterGen.current;
    setProjectFilter(next);
    if (next) selectLastUsed(next);

    clearTimeout(run?.timer);
    const nav = navGen.current;
    const timer = setTimeout(() => {
      filterNav.current = null;
      // Something else moved the filter or the selection meanwhile.
      if (gen !== filterGen.current || nav !== navGen.current) return;
      // Through the ref: this render's index and handlers are 150ms stale, and
      // a stale `handleNewSession` puts the previous project's branch back.
      openFilterSessionRef.current(next);
    }, 150);
    filterNav.current = { timer, nav };
  };

  const openFilterSession = (next: string | null) => {
    const remembered = filterSelection.current[next ?? ""] ?? null;
    const restorable =
      remembered &&
      sessionIndexItems.some(
        (i) => i.sessionId === remembered && (!next || sameProject(i.projectPath, next)),
      );
    goToSession(() => {
      if (restorable) void handleSelectSessionIndexItem(remembered);
      else handleNewSession();
    });
  };
  const openFilterSessionRef = useRef(openFilterSession);
  openFilterSessionRef.current = openFilterSession;

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
    if (!path || sameProject(path, projectFilter) || !sessionInSpace(projects, space, path)) return;
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

  /// A notice or banner click. A hidden session draws its cards beside its parent,
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
    // A bot's folder is in no space and every space: it is no project.
    if (
      projectPath &&
      !botAt(bots, projectPath) &&
      !spaceProjects.some((p) => p.path === projectPath)
    ) {
      handleSelectProject(spaceProjects[0]?.path ?? null);
    }

    if (!selectedSessionId) return;
    const openPath =
      selectedSession?.projectPath ??
      sessionIndexItems.find((i) => i.sessionId === selectedSessionId)?.projectPath;
    // A bot's chat and its tasks belong to every space: a bot hands work to any
    // project, and a task opened from its Tasks tab must not be closed again.
    // A settled task lit in its bot's row is in no loaded index, so the row
    // says what `inBotTree` cannot.
    if (
      openPath &&
      !strip?.lit &&
      !inBotTree(bots, sessionIndexItems, selectedSessionId) &&
      !sessionInSpace(projects, space, openPath)
    ) {
      goToSession(handleNewSession);
    }
    // The membership question and its two answers. `handleSelectProject` and
    // `handleNewSession` are rebuilt every render, so listing them would run
    // this on every one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space, projects, spaceProjects, projectPath, selectedSessionId, selectedSession, sessionIndexItems, bots, strip?.lit]);

  /// The sidebar's own "New space", which is a request for the field rather
  /// than for a space — naming it is Settings' job, so this only opens the tab.
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
  const workOnIssue = (issue: { identifier: string; title: string }) => {
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
    flags: { archived?: boolean; pinned?: boolean; aside?: boolean },
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
      const groups = groupProjects(spaceProjects);
      const at = groups.findIndex((g) => g.checkouts.some((p) => p.path === projectPath));
      const next = groups[(at + 1) % groups.length];
      if (next) handleSelectProject(lastUsedCheckout(next.checkouts).path);
    },
    {
      // The chord steps exactly what the picker draws, which under a space is
      // that space's projects — a chord landing on one the menu never offered
      // is a session started somewhere the reader cannot see.
      enabled: !selectedSessionId && !issuesOpen && groupProjects(spaceProjects).length > 1,
    },
  );
  // The machine picker's twin of the above: same gate, same wrap, stepping the
  // picked project's checkouts. Bound only with somewhere else to go, so ⌘⇧S
  // is not claimed on a project that lives on one machine.
  const nextServerCheckout = projectPath ? nextCheckout(checkoutsOf(spaceProjects, projectPath), projectPath) : null;
  useHotkey(
    "server.next",
    () => {
      if (nextServerCheckout) handleSelectProject(nextServerCheckout.path);
    },
    { enabled: !selectedSessionId && !issuesOpen && nextServerCheckout !== null },
  );
  // Steps the sidebar's project filter, All Projects included, in the order the
  // filter itself draws. Wraps, for the same reason the picker's own tap does:
  // one key with a clamp dead-ends with no way back. Bound only where there is
  // more than one entry to step between.
  const stepProjectFilter = (delta: number) => {
    const entries: (string | null)[] = [null, ...groupProjects(spaceProjects).map((g) => g.checkouts[0].path)];
    const from = projectFilter ? entries.findIndex((e) => e && sameProject(e, projectFilter)) : 0;
    const at = from === -1 ? 0 : from;
    // The chords and the swipe both step through here, so both tick.
    if (entries.length > 1) playSwipeTick();
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
  useHotkey("session.prev", () => goToSession(() => stepRow(-1)));
  useHotkey("session.next", () => goToSession(() => stepRow(1)));
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
  // Nine digits, so a tenth pane has no chord — it still takes a click.
  useDigitHotkey("pane.focus", (slot) => focusPane(slot + 1), { enabled: gridShown });
  // ⌘W closes the innermost thing the main column has open, which is what it
  // means in every editor and browser this app is read beside. The views are
  // mutually exclusive, so the chain is an ordering rather than an
  // arbitration — bar the last arm, which is the reader on Chat with the
  // browser beside it in the panel and no grid to close a pane out of.
  const closeBrowserTab = () => {
    if (!browserSession) return;
    // A blank tab has no browser behind it, so it is dropped rather than
    // closed — and it is what the reader is looking at while it is up.
    if (blankTabs.active !== null) return closeBlankTab(browserSession, blankTabs.active);
    const open = browserTabs?.find((tab) => tab.active);
    if (open && open.id !== recordedTab(browserSession)) void closeTab(browserSession, open.id);
  };
  // `viewTab` is per session and the issues page does not clear it, so a
  // reader who opened Issues from the Files view still has `activeFile`
  // naming a tab in a view nobody can see — and ⌘W there closed it silently.
  // Every other arm already carries the guard: `fullBrowserOpen` and
  // `gridShown` both hold `!issuesOpen`, and `panelShown` is the pane the
  // page hides.
  const fileShown = !issuesOpen && viewTab === "files" && !!activeFile;
  const litPickFile = (() => {
    if (issuesOpen || litPick?.kind !== "files") return undefined;
    const { open, active } = openFilesFor(pickFilesKey(litPick));
    return open.find((f) => f.path === active);
  })();
  const rowTabOnScreen =
    !issuesOpen &&
    !!selectedSessionId &&
    (viewTab === "files" || viewTab === "changes" || viewTab === "pick" || fullBrowserOpen || !!strip?.lit);
  const closeTabOrPane = () => {
    if (!selectedSessionId) return;
    // The row's own close, so the chord lands where the cross would — and
    // reaches the Files and Diff tabs themselves once nothing is open in them.
    if (rowTabOnScreen && closeActiveTab()) return;
    if (fileShown && activeFile) return closeFile(selectedSessionId, activeFile);
    if (fullBrowserOpen) return closeBrowserTab();
    if (gridShown) return closeSessionPane(selectedSessionId);
    if (panelShown && activeTab === "browser") closeBrowserTab();
  };
  // Bound only where it has something to close: `useHotkey` claims every chord
  // it matches, and a ⌘W that eats the key and does nothing is worse than one
  // the app never had.
  const hasCloseTarget =
    rowTabOnScreen ||
    fileShown ||
    ((fullBrowserOpen || (panelShown && activeTab === "browser")) &&
      (pendingBrowserTab || !!hasBrowserTabs)) ||
    gridShown;
  useHotkey("tab.close", closeTabOrPane, { enabled: hasCloseTarget });
  // ⌘E for the right pane against ⌘B for the left.
  //
  // Bound to the bare toggle, deliberately: the titlebar's PR face picks its
  // tab on the way open, which is right for a button the reader aimed at and
  // wrong for a chord that draws nothing and so promises nothing. Off on the
  // issues page, whose own binding opens and shuts the
  // issue pane — only the list knows which row to put back.
  useHotkey("panel.toggle", togglePanel, { enabled: !issuesOpen });
  // ⌘⌥E, the side beside ⌘E's visibility. Moves a hidden pane too: the pick
  // is a preference, and it lands wherever the pane next opens.
  useHotkey("panel.side", () => setPanelSide((s) => (s === "left" ? "right" : "left")));
  // ⌘⌥[ / ⌘⌥] — ⌥ because ⌘⇧[ ] steps the titlebar's tabs, every browser's
  // chord. The physical key rides along, since ⌥ moves the character `key`
  // reports — see `code`.
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
    if (browserShown && browserSession) {
      if (!pendingBrowserTab && browserTabs?.some((tab) => tab.active)) {
        void navigate(browserSession, "reload");
      }
      return;
    }
    if (panelShown) panelRefresh?.onRefresh();
  });
  // ⌘⇧← / ⌘⇧→ step the browser's strip, clamped like every other subtab row.
  // The pending tab sits at the end of it, which is where the strip draws it.
  const stepBrowserTab = (delta: number) => {
    if (!browserSession || !browserTabs) return;
    const from = pendingBrowserTab ? browserTabs.length : browserTabs.findIndex((tab) => tab.active);
    const next = browserTabs[from + delta];
    if (!next) return;
    if (pendingBrowserTab) setPendingTab(browserSession, false);
    if (!next.active) void activateTab(browserSession, next.id);
  };
  // The Diff view and an open file step their own strip on this chord, and the
  // main column's row wins over a browser sitting beside it in the panel.
  const browserStep = { enabled: browserShown && viewTab !== "changes" && !fileShown, skipInTextField: true };
  useHotkey("subtab.prev", () => stepBrowserTab(-1), browserStep);
  useHotkey("subtab.next", () => stepBrowserTab(1), browserStep);
  // ⌘T lives in `ViewTabs`: a new tab from anywhere the row is drawn.
  // ⌘S writes the doc on screen. Unregistered rather than a no-op off that tab:
  // `useHotkey` claims every chord it matches, and ⌘S is the browser's own save
  // — left bound everywhere it would eat the key from nothing at all.
  useHotkey("doc.save", () => saveActiveDoc(selectedSessionId), {
    enabled: panelShown && activeTab === "docs",
  });
  // The same ⌘S on any composer, wherever the docs tab is not the one taking it.
  // Off Chat the composer is hidden, so there is nothing on screen to save.
  useHotkey("composer.draft", () => void saveAsDraft(), {
    enabled: !issuesOpen && viewTab === "chat" && !(panelShown && activeTab === "docs"),
  });
  // ⌘1–⌘9 live in `ViewTabs`, which is drawn only where there is a row to
  // switch, so the issues page and a new task need no guard of their own.
  // ⌘, — every macOS app's preferences chord, and the only way into settings
  // while the sidebar is collapsed and its gear gone with it. Safe to take for
  // `useHotkey`'s usual pair of reasons: it claims the chord, and the app's
  // custom menu carries no Settings item to swallow the key first.
  useHotkey("settings", () => setSettingsOpen(true));
  // No notice on landing: the whole window changing is the answer.
  useHotkey("theme.next", cycleTheme);
  useHotkey("mode.toggle", toggleMode);
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
  const agentTurnRunning = (agent: Harness) =>
    turnRunningOn(agent, statusBySession, sessionIndexItems, (id) => serverOfSession(id) === LOCAL);
  useAutoUpdateAgents(enabledAgents, agentTurnRunning);
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
        offersFast(harness, models.find((m) => m.id === modelId)),
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
  // Only a windowed Mac has traffic lights over the strip to clear.
  const lights = IS_MAC && !fullscreen;

  // The session on screen, whether or not its transcript has landed. A session
  // just selected is not in memory for the round trip that reads it, and
  // `selectedSession` is null for exactly that window — so every arrangement
  // gated on it, the centred composer, the view tabs and the right pane, was
  // torn down at the click and rebuilt when the read answered. In the main
  // column that read as the switch, and the pane
  // and the column remounting under rows that had not moved, and only ever on
  // a row's first open (DRA-274). The index carries what the layout needs of
  // it meanwhile. The transcript still waits on the snapshot, and draws an
  // empty pane until it lands rather than a different screen.
  const shownSession =
    selectedSession ?? sessionIndexItems.find((i) => i.sessionId === selectedSessionId) ?? null;
  // The session whose row the titlebar draws: the bot's chat over its lit task.
  const rowSession = stripOwner ?? shownSession;
  // The way back from a hidden session, where its bot's row is not drawn.
  const crumb = strip ? undefined : hiddenParent;
  // Off the index, never the snapshot: `session_changed` writes only there.
  const selectedItem =sessionIndexItems.find((i) => i.sessionId === selectedSessionId);
  // The empty composer is a bot's first chat when it is aimed at the bot's folder.
  const newBot = !shownSession && projectPath ? botAt(bots, projectPath) : undefined;
  // A bot whose empty chat opens on a welcome (Dray Bot) draws as a chat
  // already under way: the welcome in the transcript, the composer below it.
  const welcomeBot = newBot?.welcome ? newBot : undefined;
  // In a bot's chat `@` lists the other bots instead of files: those on its
  // own server, the only ones `dray bot send` reaches from there.
  const composerBot = selectedBot ?? newBot;
  const composerBots = useMemo(() => {
    if (!composerBot) return undefined;
    const server = serverOfBot(composerBot);
    return bots.filter((b) => b.id !== composerBot.id && serverOfBot(b) === server);
  }, [bots, composerBot]);
  // Its agent is the reader's own where that one is installed, else the first
  // installed in the picker's order, Claude Code first.
  useEffect(() => {
    if (!welcomeBot || !agents) return;
    if (agents.find((a) => a.harness === harness)?.available) return;
    const installed = HARNESS_ORDER.find((h) => agents.find((a) => a.harness === h)?.available);
    if (installed) setHarness(installed);
    // Once per open bot and per availability answer, never on the reader's own pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [welcomeBot?.id, agents]);

  // What every transcript on screen reports back through: the main column, a
  // split pane and a crew card alike.
  /// Steps into a task tab: its chat on screen, the bot's row kept above it.
  const pickTaskTab = (bot: string, id: string) => {
    setTaskTabVia(bot);
    setViewTabs((prev) => ({ ...prev, [id]: "chat" }));
    void handleSelectSessionIndexItem(id);
  };

  /// A task clicked in a bot's chat or its Tasks tab opens as a tab in the
  /// bot's row (#881). ⌘-click, or a session that is no task of this bot,
  /// switches to it alone, the way it always did.
  const openTask = async (id: string, alone = false) => {
    const bot = selectedBot;
    // A settled task is in no crew, so it is asked for and its parents walked
    // up to the bot's folder — any of its chat's sessions, since a task
    // started before an agent switch names the old one. Its chat still names
    // it, so a settled task opens as a tab again. Bounded like `inBotTree`.
    const indexItem = (sid: string) =>
      sessionIndexItems.find((i) => i.sessionId === sid) ??
      invoke<SessionIndexItem | null>("session_index_item", { sessionId: sid }).catch(() => null);
    let task = crew.find((r) => r.item.sessionId === id)?.item;
    if (!task && bot && !alone) {
      const found = await indexItem(id);
      let at = found;
      for (let hops = 0; at?.parentSessionId && hops < 8; hops++) {
        const parent = await indexItem(at.parentSessionId);
        if (parent && botAt(bots, parent.cwd)?.id === bot.id) {
          task = found ?? undefined;
          break;
        }
        at = parent;
      }
    }
    if (alone || !bot || !task) {
      setTaskTabVia(null);
      void handleSelectSessionIndexItem(id);
      return;
    }
    setTaskTabs((prev) => openTaskTab(prev, bot.id, { sessionId: id, title: task.title }));
    pickTaskTab(bot.id, id);
  };


  /// Closes the picks on `target` — every kind, or only `kind` — and frees
  /// the file stores they and any other pick held for it.
  const dropPicksOn = (target: string, kind?: PickTab["kind"]) => {
    for (const t of Object.values(pickTabsRef.current).flat()) {
      if (t.target === target && (!kind || t.kind === kind)) forgetOpenFilesUnder(`pick:${t.id}:`);
      else forgetOpenFiles(pickFilesKey({ ...t, target }));
    }
    if (!kind) pickSeen.current.delete(target);
    setPickTabs((prev) => closePicksOn(prev, target, kind));
  };
  const pickTabsRef = useRef(pickTabs);
  pickTabsRef.current = pickTabs;
  const dropPicksOnRef = useRef(dropPicksOn);
  dropPicksOnRef.current = dropPicksOn;
  // Settling leaves a task's work to review but nothing to open, so its Files
  // picks close; deleting its worktree leaves no diff either. Its tab in the
  // bot's row closes too: done work is reopened from a card, not kept open.
  // Read off the index event, since the bot settles tasks itself as often as
  // the reader, and every settle, Merge's included, announces one.
  useEffect(() => {
    const un = listen<SessionIndexItem>("session_changed", ({ payload }) => {
      if (payload.archived) setTaskTabs((prev) => closeTaskTab(prev, payload.sessionId));
      if (payload.worktreeRemoved) dropPicksOnRef.current(payload.sessionId);
      else if (payload.archived) dropPicksOnRef.current(payload.sessionId, "files");
    });
    return () => void un.then((off) => off());
  }, []);

  const deleteTask = async (id: string) => {
    if (await deleteSession(id)) {
      setTaskTabs((prev) => closeTaskTab(prev, id));
      dropPicksOn(id);
    }
  };

  /// Merges a task's pull request, then settles the task where `task` is
  /// given — the Tasks tab's Merge, and a merge card's in a bot's chat.
  const mergeTask = async (
    projectPath: string,
    number: number,
    method: MergeMethod,
    task: { item: SessionIndexItem; busy: boolean } | null,
  ) => {
    // From the repo root: a task's worktree may already be gone.
    await invoke("merge_pr", { cwd: projectPath, number, method });
    prMarks.refreshAfterWrite();
    // Landed, so the task is done — unless it is still working,
    // which settling would kill mid-turn.
    if (!task) return;
    const { item } = task;
    if (task.busy || !(await setSessionFlags(item.sessionId, { archived: true }))) return;
    if (!item.worktreeName || item.worktreeRemoved) return;
    // The tree goes without a word only where it holds nothing
    // the merge did not take; anything else is the settle notice's
    // question, never a silent delete.
    const left = await invoke<WorktreeDisposition>("worktree_disposition", { sessionId: item.sessionId }).catch(
      () => null,
    );
    if (left && (!left.exists || (left.changedFiles === 0 && left.unpushedCommits === 0))) {
      removeWorktree(item.sessionId, "tidy");
    } else {
      void askAboutWorktree(item.sessionId, item.worktreeName, item.title, "notice");
    }
  };

  const cardsReread = useRef(new Set<string>());
  const rereadQueued = useRef(false);
  const mergeCardHost: MergeCardHost = {
    prNumbered: prMarks.prNumbered,
    // Every card missing in one commit shares one read of the repos on screen:
    // a long chat of old cards must not spend the `gh` budget once per card.
    missing: (repo, number) => {
      const key = `${repo}#${number}`;
      if (cardsReread.current.has(key)) return;
      cardsReread.current.add(key);
      if (rereadQueued.current) return;
      rereadQueued.current = true;
      queueMicrotask(() => {
        rereadQueued.current = false;
        prMarks.refresh();
      });
    },
    titleOf: (id) => sessionIndexItems.find((i) => i.sessionId === id)?.title,
    merge: async (card, method, settle) => {
      const item = settle
        ? (sessionIndexItems.find((i) => i.sessionId === card.taskId) ??
          (await invoke<SessionIndexItem | null>("session_index_item", { sessionId: card.taskId }).catch(() => null)))
        : null;
      const busy = (statusBySession[card.taskId] ?? item?.status) === "in_progress";
      // A task moved off the card's branch holds work this merge did not land.
      const landed = item && !item.archived && sessionBranch(item) === card.branch;
      return mergeTask(card.projectPath, card.number, method, landed ? { item, busy } : null);
    },
    open: (id, alone) => paneChat.onOpenSession(id, alone),
    fixConflicts: async (card) => {
      // The loaded list is one side of the sidebar; the settled side may be up.
      const task =
        sessionIndexItems.find((i) => i.sessionId === card.taskId) ??
        (await invoke<SessionIndexItem | null>("session_index_item", { sessionId: card.taskId }));
      if (!task) throw new Error("This task is gone.");
      await askToFixConflicts(task, card.number);
    },
  };

  const paneChat: PaneChat = {
    onOpenSubagent: openSubagent,
    onOpenSession: (id, alone) =>
      selectedBot ? void openTask(id, alone) : void handleSelectSessionIndexItem(id),
    onOpenSubagentPanel: () => showPanel("more"),
    onOpenPlan: () => showPanel("plan"),
    onRespondPermission: handleRespondPermission,
    onAnswerQuestions: handleAnswerQuestions,
    onSendNow: handleInterrupt,
  };

  /// A lit Diff or Files pick: the view on the picked session, its side
  /// column led by the picker. Keyed on tab and target, so a repick or another
  /// pick of the same kind opens fresh rather than on the last one's place.
  const pickBody = (tab: (typeof litPick) & object, bot: string) => {
    const options: PickOption[] = [
      ...(tab.kind === "files" ? [bot] : []),
      ...botTasks.map((t) => t.sessionId),
    ].map((sessionId) => ({ sessionId, title: pickTitle(sessionId), face: pickFace(sessionId) }));
    const picker = (
      <PickTarget
        options={options}
        value={tab.target}
        current={{ sessionId: tab.target, title: pickTitle(tab.target), face: pickFace(tab.target) }}
        onPick={(target) => setPickTabs((prev) => repickTab(prev, bot, tab.id, target))}
      />
    );
    const item = pickItem(tab.target);
    // A deleted worktree leaves `cwd` on the project root, whose tree is not
    // this task's work.
    if (!item || item.worktreeRemoved) {
      return (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-72 shrink-0 flex-col border-r border-border">{picker}</div>
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-ui text-muted-foreground">
            {item ? "This task's worktree was deleted." : "This task is gone."} Pick another.
          </div>
        </div>
      );
    }
    // The task's turns are what move its tree; its transcript is not loaded
    // here, so its index entry's activity stamp and status stand in, and a
    // tick moves the working tree's reads mid-turn, at `useChanges`'s own gap.
    const status = statusBySession[tab.target] ?? item.status;
    const revision = `${item.modified}:${status}`;
    const writeRevision = `${revision}:${pickTick}`;
    const key = `${tab.id}:${tab.target}`;
    return tab.kind === "changes" ? (
      <ChangesView
        key={key}
        cwd={item.cwd}
        active={!issuesOpen}
        revision={revision}
        writeRevision={writeRevision}
        busy={status === "in_progress"}
        picker={picker}
      />
    ) : (
      <FilesView
        key={key}
        sessionId={pickFilesKey(tab)}
        cwd={item.cwd}
        active={!issuesOpen}
        revision={revision}
        picker={picker}
      />
    );
  };

  // Pages with no tabs for the strip: the sheet reaches up behind the header.
  const tallSheet = issuesOpen || !shownSession;

  return (
    <TooltipProvider>
    <MergeCardHostContext value={mergeCardHost}>
    <DiffWorkerPool pair={codeThemePair}>
    {/* Hidden, not unmounted, while settings take the window: transcripts,
        scroll pins and drafts wait here. `display: none` is also what takes
        the browser's native view down, its pane measuring zero. */}
    <div className={cn("h-full w-full", settingsOpen && settingsReady && "hidden")}>
    <AppShell
      sidebarOpen={!collapsed}
      tall={tallSheet}
      // The issues page fills the column, so the centred empty-composer state
      // is wrong there even with no session selected.
      centered={!shownSession && !issuesOpen && !welcomeBot}
      panelLeft={panelSide === "left"}
      panelOpen={issuesOpen ? !!pickedIssue : !!shownSession && panelShown}
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
            rows={crewAsks}
            paneState={paneState}
            onOpen={(id) => void handleSelectSessionIndexItem(id)}
            chat={paneChat}
          />
        ) : undefined
      }
      sidebar={
        <Sidebar
          items={searchedSessions}
          bots={botList}
          onOpenBot={openBot}
          // The new-task composer first: the dialog shares its picker, which on
          // an open chat would change that chat's model instead.
          onNewBot={() => {
            goToSession(handleNewSession);
            setBotServer(LOCAL);
            setNewBotOpen(true);
          }}
          onDeleteBot={setBotToDelete}
          search={search}
          onSearchChange={setSearch}
          searchOpen={searchOpen}
          onSearchOpenChange={setSearchOpen}
          projects={spaceProjects}
          space={space}
          projectFilter={projectFilter}
          onProjectFilterChange={changeProjectFilter}
          onStepProjectFilter={stepProjectFilter}
          statusBySession={statusBySession}
          unreadWorking={unreadWorking}
          askingSessions={sidebarAsking}
          prFor={prMarks.prFor}
          // Cleared while the page is up. The column is showing issues, so a
          // lit row would name a session that is nowhere on screen — and the
          // selection itself is kept, which is what makes coming back free.
          // A task lit in a bot's row keeps the bot's row marked: the task
          // has none, and the bot's chat is one tab away.
          selectedSessionId={issuesOpen ? null : strip?.owner ?? selectedSessionId}
          collapsed={collapsed}
          onSelect={(sessionId) => goToSession(() => void handleSelectSessionIndexItem(sessionId))}
          onPrefetch={(sessionId) => void ensureLoaded(sessionId)}
          groups={spaceGroups}
          onDropSession={dropSession}
          splitLearned={splitLearned}
          onNewSession={() => goToSession(handleNewSession)}
          onNewSessionInProject={(path) =>
            goToSession(() => {
              selectLastUsed(path);
              handleNewSession();
            })
          }
          onOpenIssues={() => setIssuesOpen(true)}
          issuesOpen={issuesOpen}
          drafts={sidebarDrafts}
          openDraftId={issuesOpen ? null : openDraftId}
          onOpenDraft={openDraft}
          onDeleteDraft={(id) => {
            writeDraft(draftKey(id), "");
            clearAttachments(draftKey(id));
            removeDraft(id);
          }}
          onDetach={detachSession}
          onSetFlags={handleSetSessionFlags}
          onFork={forkSession}
          onDelete={deleteTask}
          onMarkUnread={markSessionUnread}
          archivedShown={archivedShown}
          archivedRequested={archivedRequested}
          onToggleArchived={() => {
            if (draftsShown) setOpenDraftId(null);
            setDraftsShown(false);
            setShowArchived((v) => draftsShown || !v);
          }}
          draftsShown={draftsShown}
          onToggleDrafts={() => {
            if (draftsShown) setOpenDraftId(null);
            else setShowArchived(false);
            setDraftsShown(!draftsShown);
          }}
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
          //
          // It spans the window, sidebar and panes below it, so it is the row
          // that clears the traffic lights — fullscreen and Linux have none. A step darker
          // than the window, so the active tab can stand out of it the way a
          // browser's does.
          className={cn(
            // No fill of its own: it floats over the frame, whose strip above
            // the sheet is what gives this row its colour.
            "relative flex h-(--titlebar-h) shrink-0 items-center gap-2 overflow-hidden px-3",
            lights && "pl-(--traffic-lights-w)",
            // What sits before the tab row: this padding, the 28px sidebar
            // toggle and one gap. `ViewTabs` lines its row up from it.
            lights ? "[--tabs-lead:calc(var(--traffic-lights-w)+2.25rem)]" : "[--tabs-lead:3rem]",
          )}
          // `deep`, not bare: bare drags only on direct hits, so every label
          // inside this row was a dead strip in a titlebar that looks uniform.
          // Buttons still block on their own — Tauri stops walking up at any
          // clickable element that carries no attribute of its own.
          data-tauri-drag-region="deep"
        >
          {/* Always here, open or shut: the sidebar sits under this row now,
              so the toggle no longer has a strip of its own to live in. */}
          <SidebarToggle onToggle={toggleSidebar} />

          {/* Over the sidebar's right end, out of the flow so the tabs do not
              move. It belongs to the sidebar, so it goes when the sidebar does —
              and on a hidden session, whose way back to its parent runs
              through this same strip. ⌘, still opens settings there. */}
          {sidebarDrawn > 0 && !(!issuesOpen && shownSession && crumb) && (
          <div
            className="absolute top-1/2 flex shrink-0 -translate-y-1/2 items-center gap-1"
            style={{ right: `calc(100% - ${sidebarDrawn}px + 0.5rem)` }}
          >
            {/* Only once a space exists — before that the switcher has nothing
                to switch, and New space lives in Settings. */}
            {spaces.length > 0 && (
              <SpaceSwitcher
                spaces={spaces}
                value={space}
                // Only while the dialog is actually up: it is cleared on close,
                // so a cancelled naming puts the switcher back on All Spaces.
                naming={settingsOpen && namingSpace}
                onChange={changeSpace}
                onNew={openNewSpace}
              />
            )}
            <SettingsButton onOpen={() => setSettingsOpen(true)} />
          </div>
          )}

          {/* With a session up, the session is the strip's first tab and the
              header has nothing left to say; it stays for the pages that are
              not a session — the issues page, a new task. */}
          {/* A hidden session has no sidebar row, so this is the way back to
              the session that started it. */}
          {!issuesOpen && shownSession && crumb && (
            <button
              type="button"
              onClick={() =>
                goToSession(() => void handleSelectSessionIndexItem(crumb.sessionId))
              }
              className="max-w-40 shrink-0 cursor-pointer truncate text-ui text-muted-foreground transition-colors hover:text-foreground"
            >
              {crumb.title} /
            </button>
          )}
          {!issuesOpen && shownSession && rowSession && (
            <ViewTabs
              // With a task tab lit, still the bot's row: its chat, pages and
              // files, the task tabs after them.
              sessionId={rowSession.sessionId}
              browserId={browserOf(rowSession.sessionId)}
              // The group's name over a grid, for the reason the header gave:
              // each pane already names its own session. The project is left
              // off where the sidebar is already filtered down to it.
              title={
                mainGroup
                  ? groupName(mainGroup)
                  : projectFilter
                    ? rowSession.title
                    : withProject(rowSession, botAt(bots, rowSession.projectPath)?.name ?? basename(rowSession.projectPath))
              }
              machine={mainGroup ? undefined : serverOfPath(rowSession.projectPath)}
              // A bot chat's header is the bot's name, renamed with the bot.
              rename={
                mainGroup || botAt(bots, rowSession.cwd)
                  ? undefined
                  : {
                      title: rowSession.title,
                      save: (title) =>
                        void invoke("rename_session", { sessionId: rowSession.sessionId, title }).catch(
                          (e) => console.error("rename failed", e),
                        ),
                    }
              }
              tab={stripOwner ? viewTabs[stripOwner.sessionId] ?? "chat" : viewTab}
              onChange={
                stripOwner
                  ? (tab) => {
                      setViewTabs((prev) => ({ ...prev, [stripOwner.sessionId]: tab }));
                      void handleSelectSessionIndexItem(stripOwner.sessionId);
                    }
                  : setViewTab
              }
              working={stripOwner ? statusBySession[stripOwner.sessionId] === "in_progress" : busy}
              branch={prBranch}
              cwd={shownSession.cwd}
              tasks={
                strip
                  ? {
                      items: (taskTabs[strip.bot] ?? []).map((t) => ({
                        sessionId: t.sessionId,
                        title: sessionIndexItems.find((i) => i.sessionId === t.sessionId)?.title ?? t.title,
                        working: statusBySession[t.sessionId] === "in_progress",
                      })),
                      lit: strip.lit,
                      onPick: (id) => pickTaskTab(strip.bot, id),
                      onClose: (id) => setTaskTabs((prev) => closeTaskTab(prev, id)),
                      onReopen: (id) =>
                        setTaskTabs((prev) =>
                          openTaskTab(prev, strip.bot, {
                            sessionId: id,
                            title: sessionIndexItems.find((i) => i.sessionId === id)?.title ?? "Task",
                          }),
                        ),
                    }
                  : undefined
              }
              picks={
                strip
                  ? {
                      items: (pickTabs[strip.bot] ?? []).map((t) => ({
                        ...t,
                        title: pickTitle(t.target),
                        filesKey: pickFilesKey(t),
                      })),
                      lit: pickLit[strip.bot] ?? null,
                      canDiff: botTasks.length > 0,
                      onPick: (id) => showPick(strip.bot, strip.owner, id),
                      onAdd: (kind) => {
                        // The task last at work, which is most often the one
                        // the reader came to look at.
                        const target = newestSession(botTasks) ?? (kind === "files" ? strip.bot : null);
                        if (!target) return;
                        const id = crypto.randomUUID();
                        setPickTabs((prev) => addPickTab(prev, strip.bot, { id, kind, target }));
                        showPick(strip.bot, strip.owner, id);
                      },
                      onClose: (id) => {
                        forgetOpenFilesUnder(`pick:${id}:`);
                        setPickTabs((prev) => closePickTab(prev, strip.bot, id));
                      },
                      onReopen: (kind, target) => {
                        const id = crypto.randomUUID();
                        setPickTabs((prev) => addPickTab(prev, strip.bot, { id, kind, target }));
                        return id;
                      },
                    }
                  : undefined
              }
              // Not past a parent's breadcrumb, whose width the lead leaves out.
              alignX={crumb ? 0 : sidebarDrawn}
            />
          )}
          {/* Keeps the far end at the far end on pages with no tab row. */}
          {(issuesOpen || !shownSession) && <div className="min-w-0 flex-1" />}


          {issuesOpen
            ? // Only once something is open to close. Nothing on this page can
              // *open* the pane — a row does that — so a toggle drawn at rest
              // would be a control with one dead state.
              pickedIssue && (
                <PanelToggle onToggle={() => setPickedIssue(null)} />
              )
            : shownSession && (
                <>
                  <PanelActions
                    // In the Files view alone: the file on screen, or the
                    // session's directory where no file is open.
                    cwd={
                      viewTab === "files"
                        ? shownSession.cwd
                        : litPick?.kind === "files"
                          ? (pickItem(litPick.target)?.cwd ?? null)
                          : null
                    }
                    file={
                      fileShown
                        ? openFiles.find((f) => f.path === activeFile)
                        : litPickFile}
                  />
                  {/* A pull request, open or merged, stands in for the toggle and opens
                      the pane on itself; the pane's own tabs are inside it. */}
                  {prFace ? (
                    <ItemTab
                      icon={prFace.icon}
                      label={prFace.label}
                      active={panelShown}
                      onPick={() => {
                        if (!panelShown) setPanelTab("pr");
                        togglePanel();
                      }}
                      fixed
                      hint={
                        <>
                          Toggle panel
                          <ShortcutKeys ids={["panel.toggle"]} />
                        </>
                      }
                    />
                  ) : (
                    <PanelToggle onToggle={togglePanel} />
                  )}
                </>
              )}
          <WindowControls />
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
            open={panelShown}
            tab={activeTab}
            onTabChange={setPanelTab}
            tabs={tabs}
            widthKey={shownSession.sessionId}
            refresh={panelRefresh}
            cwd={shownSession.cwd}
          >
            <TabBody active={activeTab === "changes"}>
              <MountOnce when={panelShown && activeTab === "changes"}>
              <ChangesPanel
                cwd={shownSession.cwd}
                baseline={baseline}
                onOpenRepo={() => setViewTab("changes")}
                {...shownChanges}
              />
              </MountOnce>
            </TabBody>
            <TabBody active={activeTab === "browser"}>
              <MountOnce when={panelShown && activeTab === "browser"}>
              <BrowserPane
                sessionId={browserSession ?? shownSession.sessionId}
                active={panelShown && activeTab === "browser"}
                mode="panel"
                fullOpen={fullBrowserOpen}
                onExpand={expandBrowser}
                onCollapse={collapseBrowser}
              />
              </MountOnce>
            </TabBody>
            <TabBody active={activeTab === "tasks"}>
              <TasksPanel
                rows={crew}
                prOf={(row) => prMarks.prFor(row.item.projectPath, sessionBranch(row.item))}
                onOpen={(id, alone) => void openTask(id, alone)}
                onSetFlags={handleSetSessionFlags}
                onFork={forkSession}
                onDelete={deleteTask}
                onDetach={detachSession}
                onFixConflicts={(row, pr) => askToFixConflicts(row.item, pr.number)}
                onMerge={(row, pr, method) => mergeTask(row.item.projectPath, pr.number, method, row)}
                now={stalled.now}
              />
            </TabBody>
            <TabBody active={activeTab === "more"}>
              <MorePanel
                todos={sessionTodos}
                live={busy}
                media={sessionAttachments}
                sessionId={shownSession.sessionId}
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
        // `shownSession`, like the rest of the layout: gated on the snapshot,
        // the composer came up under Files or Diff for as long as a transcript
        // took to load.
        issuesOpen || (shownSession && viewTab !== "chat") ? null : (
        <ChatInput
          onSend={(message, attachments) => void sendFromComposer(message, attachments)}
          commands={slashCommands}
          commandsLoading={slashCommandsLoading}
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
            HAS_DICTATION && <DictateControl
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
          sessionId={composerKey}
          isNewTask={!shownSession && !welcomeBot}
          target={composerTarget}
          issuesConnected={issuesConnected}
          issueTrackers={integrations.connected}
          sessions={composerSessions}
          bots={composerBots}
          onSessionPickerOpen={refreshReachableSessions}
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
          // None in a bot's chat: its folder holds notes, not work to hand off.
          handoff={
            inBotFolder ? null : (
              <HandoffRow
                actions={handoffActions(workStatus, sessionHasPr, !!selectedSessionId, handoffConfig)}
                // Straight out as a prompt, exactly as if it had been typed. A
                // turn already running queues it, like any other send.
                onSend={(prompt) => void handleSendMsg(prompt)}
                disabled={!selectedSessionId || !!sendHeld}
              />
            )
          }
          // Only on a new task. An agent is fixed at creation, so a live
          // session cannot be pointed at one that is missing — and a session
          // that already exists has a CLI that already ran.
          notice={
            sleepingBoat ? null : offlineServer ? (
              <ServerOfflineNotice server={offlineServer} />
            ) : !selectedSessionId && missingAgent ? (
              <AgentMissingNotice agent={missingAgent} />
            ) : loggedOutAgent && authTurn && selectedSession ? (
              <LoginExpiredNotice
                agent={loggedOutAgent}
                server={activeServer}
                cwd={selectedSession.cwd}
                onHandled={() => setLoginHandled(authTurn)}
              />
            ) : null
          }
          pending={
            sleepingBoat ? (
              <BoatNotice server={sleepingBoat} />
            ) : selectedBot && selectedSession && harness !== selectedSession.harness ? (
              // A bot chat picked onto another agent: the send moves it there.
              <div className="mb-2 flex min-h-7 items-center gap-2 px-1">
                <AgentIcon harness={harness} brand className="size-3.5 shrink-0" />
                <p className="min-w-0 flex-1 truncate text-ui text-foreground">
                  Moving to {AGENT_LABELS[harness]}
                  <span className="text-muted-foreground"> · Your next message goes to it, with this conversation.</span>
                </p>
              </div>
            ) : selectedItem?.continueAt && (
              <AutoContinueNotice
                at={selectedItem.continueAt}
                off={selectedItem.continueOff}
                onToggle={(on) =>
                  void invoke("set_auto_continue", { sessionId: selectedItem.sessionId, on }).catch(
                    setError,
                  )
                }
              />
            )
          }
          held={sendHeld}
          draftHint={
            openDraftId ? (
              <span className={cn("transition-colors duration-300", draftNudge && "text-foreground")}>
                Changes auto-saved
              </span>
            ) : (
              draftChord && `${formatChords([draftChord])[0].join("")} to save as draft`
            )
          }
          agentUpdate={
            !selectedSessionId && (
              <AgentUpdateLine
                harness={harness}
                waiting={overwritesInPlace(harness) && agentTurnRunning(harness)}
              />
            )
          }
          toolbar={
            <ComposerToolbar
              server={activeServer}
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
              onAttach={() => void pickAttachments(attachmentKey(composerKey, composerCwd))}
              contextUsage={contextUsage}
              isNewSession={!selectedSessionId}
              agentSwitch={!!selectedBot}
              bot={newBot}
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
          picked={pickedIssue}
          onPick={setPickedIssue}
          onWorkOn={workOnIssue}
          refreshRef={issuesRefreshRef}
          connected={integrations.connected}
          onConnect={integrations.connect}
          connecting={integrations.busy}
          connectError={integrations.error}
          onRecheckGithub={integrations.recheckGithub}
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
          onDrop={dropSession}
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
      <div className="min-h-0 flex-1">
        {/* A transcript its server has not answered for yet; the reconnect
            loads it. One already loaded keeps drawing what it has. */}
        {offlineServer && !selectedSession ? (
          <TranscriptSkeleton still={offlineServer.status !== "connecting"} />
        ) : welcomeBot?.welcome && !selectedSessionId ? (
          <BotWelcome text={welcomeBot.welcome} />
        ) : (
          <Chat
            {...paneState(selectedSessionId ?? "")}
            {...paneChat}
            bot={!!selectedBot}
            earlier={earlier}
            earlierLoading={earlier.length < earlierIds.length}
            taskOf={taskOf}
            onOpenBot={openBot}
            botFooter={
              <StalledTasks
                stalls={stalls}
                now={stalled.now}
                onFocus={(sessionId) =>
                  selectedBot && setStallFocus({ botId: selectedBot.id, sessionId, at: Date.now() })
                }
                onOpen={(id, alone) => void openTask(id, alone)}
                onMerge={(row, pr, method) => mergeTask(row.item.projectPath, pr.number, method, row)}
              />
            }
            botFocus={botFocus}
            unread={!!selectedSessionId && openedUnread === selectedSessionId}
            crowded={!collapsed && (panelShown || (crewDrawn && crewBeside) || (issuesOpen && !!pickedIssue))}
            // Its own chords only while the chat tab is on screen.
            active={!issuesOpen && viewTab === "chat"}
          />
        )}
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
            sessionId={browserSession ?? selectedSession.sessionId}
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
      {litPick && selectedBotId && (
        <TabBody active={!issuesOpen}>
          <MountOnce when>{pickBody(litPick, selectedBotId)}</MountOnce>
        </TabBody>
      )}
    </AppShell>
    </div>
    <BreakOverlay />
    {/* Outside `AppShell` on purpose: it is fixed to the window rather than
        placed in the layout, and the shell has no slot that isn't a pane. */}
    <BoatWarnings busy={boatBusy} />
    <NoticeStack
      onSelect={(id) => goToSession(() => void openNotice(id))}
      onOpenDrafts={() => {
        // The drafts list lives in the sidebar, as the search field does.
        setCollapsed(false);
        setShowArchived(false);
        setDraftsShown(true);
      }}
      // The session and the pane both, since the card is about something the
      // transcript does not show. The pick is written the same way
      // `usePullRequest`'s `onOpened` writes it — `activeTab` honours a
      // standing pick over the derived default.
      onOpenPr={(id) =>
        goToSession(() => {
          void openFromNotice(id);
          showPanel("pr", id);
        })
      }
      onDeleteWorktree={(id) => removeWorktree(id)}
    />
    {whatsNew && (
      <WhatsNewCard
        release={whatsNew.release}
        onDismiss={() => closeWhatsNew(false)}
        onView={() => closeWhatsNew(true)}
      />
    )}
    <DragGhost />
    <QuitDialog />
    <LinkDialog />
    {/* Mounted here rather than in the sidebar, which unmounts whole when it
        collapses and would take ⌘, with it. Not before idle, see
        `settingsWarm`. */}
    <MountOnce when={settingsOpen || settingsWarm}>
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
      onRemoveProject={handleRemoveProject}
      onCreateSpace={createSpace}
      onRenameSpace={renameSpace}
      onRemoveSpace={removeSpace}
      onMoveSpace={moveSpaceBy}
      onMoveProject={moveProject}
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
      // ordinary — a new task has no session yet. This Mac's alone: the tab
      // signs agents in through a terminal here, which a remote server's
      // agents cannot use.
      cwd={composerCwd && serverOfPath(composerCwd) === LOCAL ? composerCwd : ""}
    />
    <SettingsReady onReady={setSettingsReady} />
    </MountOnce>
    <WorktreeDialog
      prompt={worktreePrompt}
      onConfirm={(sessionId) => removeWorktree(sessionId)}
      onClose={() => setWorktreePrompt(null)}
    />
    {serverUpdateDialog}
    <NewBotDialog
      open={newBotOpen}
      onOpenChange={(open) => {
        setNewBotOpen(open);
        if (!open) setBotServer(null);
      }}
      server={botServer ?? LOCAL}
      onServerChange={setBotServer}
      picker={
        <ModelSelector
          server={activeServer}
          harness={harness}
          onHarnessChange={setHarness}
          models={models}
          modelId={modelId}
          effort={effort}
          fast={fast}
          fastNote={fastNote}
          onFastChange={setFast}
          isNewSession
          busy={false}
          onChange={handleModelChange}
          onRefreshModels={refreshModels}
          onReloadModels={reloadModels}
          onSeedProvider={seedFxModels}
          loadingModels={loadingModels}
        />
      }
      pick={{
        harness,
        model: modelId,
        effort,
        permissionMode: botStance(harness, permissionMode),
        fast,
      }}
      onStarted={(chat) => goToSession(() => void handleSelectSessionIndexItem(chat.sessionId))}
    />
    <AlertDialog open={!!botToDelete} onOpenChange={(open) => !open && setBotToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {botToDelete?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its instructions and memory go with it, and its chat is settled.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            destructive
            onClick={() => {
              const bot = botToDelete;
              if (!bot) return;
              void (async () => {
                // `delete_bot` settles the bot's open chat itself: with the
                // settled list up, the open one is not held here to settle.
                const server = serverOfBot(bot);
                await invoke("delete_bot", { id: bot.id }, server).catch((e) => setError(String(e)));
                await refreshBots(server);
              })();
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </DiffWorkerPool>
    </MergeCardHostContext>
    </TooltipProvider>
  );
}

export default App;
