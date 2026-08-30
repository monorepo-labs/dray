import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useState, useEffect, useMemo, useRef } from "react";
import { restoreAttachments } from "@/hooks/useAttachments";
import { useComposerPrefs, type EffortByModel } from "@/hooks/useComposerPrefs";
import { useDockBadge } from "@/hooks/useDockBadge";
import {
  ANSWERED_BY_OPENING,
  dismissNotice,
  pushNotice,
  type NoticeKind,
} from "@/hooks/useNotices";
import { isWindowFocused, onFocusChange } from "@/lib/focus";
import { DEFAULT_MODEL_FOR, isUnsetModel, rememberedModel, usableModel } from "@/lib/model";
import { notifyOS } from "@/lib/notify";
import { playNotification } from "@/lib/sound";
import { AgentEvent, ApprovalPolicy, Attachment, BackgroundTask, BranchList, Effort, Harness, IssueRef, Model, ModelId, Project, QueuedMessage, SendOutcome, SessionIndexItem, SessionSnapshot, SessionStatus, SessionStatusEvent, SessionTitleEvent } from "../types/events";

const DEFAULT_EFFORT: Effort = "high";

/// A held prompt and what it was sent with.
///
/// The attachments ride the queue entry rather than a store beside it, because
/// they have exactly its lifetime: one state write both queues the prompt and
/// gives the row something to draw, and one removal releases both. Held apart —
/// an imperative map pruned from an effect over this state — a prune still
/// pending from an earlier queue could flush *after* the attachments were
/// stashed and delete them before the row that wanted them ever mounted.
///
/// Resolved, not paths, and that is the point: `QueuedMessage.attachmentPaths`
/// is deliberately unresolved so a cancel hands back what the user typed, so
/// the row would otherwise have to describe them a second time.
export type QueuedPrompt = {
  message: QueuedMessage;
  attachments: Attachment[];
};

/// A stretch where the agent is busy and the transcript has nothing to show —
/// a request in flight, or a thinking block, which Claude Code streams as an
/// *empty* string with only a token estimate and so renders nothing at all from
/// open to commit.
///
/// The two are not told apart. The indicator's word is picked at random and
/// "Thinking" is one of the options, so knowing which kind of wait this is would
/// change nothing on screen.
export type Working = {
  /// Live estimate off `usage_update.reasoningTokens`, which ticks a few times a
  /// second while a thinking block is open. Zero on every other wait, and until
  /// the first update lands.
  tokens: number;
};

/// A retry the harness is in the middle of. `attempt` of `maxRetries` is the
/// whole of what is always known; the cause is named on well under half of
/// these, so both remaining fields are ordinarily absent.
export type ApiRetryState = {
  attempt: number;
  maxRetries: number;
  status: number | null;
  reason: string | null;
};

export type StreamingBlock = {
    index: number,
    type: "text" | "thinking" | "tool_use" | null
    /// Accumulated deltas. Prose for a text or thinking block; for a `tool_use`
    /// one it is the raw `input_json_delta` stream, which is a prefix of a JSON
    /// object rather than anything renderable — see [streamingCall](../lib/streaming.ts).
    text: string,
    /// Both set only on a `tool_use` block, from the `block_start` that opens it.
    /// The name is what the preview row renders before any argument has arrived;
    /// `callId` is the tool_use id, which the committed `tool_call_started`
    /// repeats as its `callId` and is matched on to retire this preview.
    name: string | null,
    callId: string | null,
}

/// Sessions whose worktree removal has been asked for and not refused.
///
/// Module-level rather than a ref because it guards a write to disk, not a
/// render: nothing draws from it, and the one thing it has to survive is the
/// composer remounting under a session switch while git is still working.
const removingWorktrees = new Set<string>();

export function useSessions() {

    // The sticky defaults. Live state below seeds from these and writes back on
    // every user-initiated change; restoring a session writes live state only.
    const [prefs, setPrefs] = useComposerPrefs();

    const [sessions, setSessions] = useState<SessionSnapshot[]>([]);
    const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
    // sessionId → the one in-flight block (CLI streams start→deltas→stop serially).
    const [streamingContentBlock, setStreamingContentBlock] = useState<Record<string, StreamingBlock | null>>({});
    const [sessionIndexItems, setSessionIndexItems] = useState<SessionIndexItem[]>([]);
    // Which side of the archived split the sidebar is showing. Not persisted:
    // archived is the exception view, so every launch starts on the active list.
    const [showArchived, setShowArchived] = useState(false);
    const [models, setModels] = useState<Model[]>([]);
    // Seeded once from prefs, then free to diverge: selecting a session overwrites
    // these with what that session was started with, which must not feed back.
    const [harness, setHarnessState] = useState<Harness>(() => prefs.harness);
    const [modelId, setModelId] = useState<ModelId>(() =>
      rememberedModel(prefs.modelByHarness, prefs.harness),
    );
    const [effortByModel, setEffortByModel] = useState<EffortByModel>(() => prefs.effortByModel);
    const [permissionMode, setPermissionModeState] = useState<ApprovalPolicy>(() => prefs.permissionMode);
    const [projects, setProjects] = useState<Project[]>([]);
    const [projectPath, setProjectPath] = useState<string | null>(null);
    // Derived from the selected project, not a preference — refetched on switch
    // and never persisted.
    const [branches, setBranches] = useState<BranchList | null>(null);
    const [branch, setBranch] = useState<string | null>(null);
    // The branch a switch is waiting on the user to confirm, because the tree
    // has uncommitted changes. Null when nothing is pending.
    const [pendingBranch, setPendingBranch] = useState<string | null>(null);
    const [useWorktree, setUseWorktreeState] = useState(() => prefs.useWorktree);
    // Per-session, not global: sessions run concurrently and all of their events
    // arrive on the same channel, so a single value would clear on another's
    // turn. The backend drives this via `session_status`, and this map is the
    // only live copy — the composer and the sidebar both read it, falling back
    // to the index item's field, which is the value as of the last list fetch.
    //
    // Mirroring each change back into the index items instead looked equivalent
    // and wasn't: a new session's status is published while its `send_msg` is
    // still in flight, so the map write has no row to land on yet, and the
    // snapshot pushed a moment later carries the `idle` it was indexed with. The
    // sidebar's dot never appeared for the session that most needed it.
    const [statusBySession, setStatusBySession] = useState<Record<string, SessionStatus>>({});
    // sessionId → the current blank-screen wait, or absent when something is
    // actually rendering. Not derived from the event list: `model_request_started`
    // and the thinking deltas that drive it are transient and unpersisted, so
    // this is the only place the state lives.
    const [workingBySession, setWorkingBySession] = useState<Record<string, Working | null>>({});
    // The background tasks each live child holds, as the CLI last published
    // them. Live state, not read off the log: a task outlives the turn that
    // spawned it, so `busy` can no longer say whether the log's last set is
    // current — and a stale non-empty set survives there across a restart. Only
    // an event this run writes here, which is what makes it honest.
    const [tasksBySession, setTasksBySession] = useState<Record<string, BackgroundTask[]>>({});
    // sessionId → prompts typed during a running turn, oldest first, still
    // waiting for the backend to hand them to the CLI. Mirrors the queue in
    // `Session`, which is the authority; this copy exists so the composer can
    // draw them. Nothing is persisted on either side, so both die with the
    // process and neither can come back stale.
    const [queuedBySession, setQueuedBySession] = useState<Record<string, QueuedPrompt[]>>({});

    // Read across the cancel's await, so it comes from a ref rather than the
    // closure's copy — the rule `sessionsRef` follows. Assigned during render
    // and not in an effect, which would leave it a render behind.
    const queuedRef = useRef(queuedBySession);
    queuedRef.current = queuedBySession;

    // sessionId → the request ids of the consent cards and questionnaires the
    // agent is standing still behind. Ids rather than a count, so the
    // `permission_decided` that retires one clears the right one when two are
    // open. Frontend-only and unpersisted for the same reason the requests
    // themselves are: no child survives a restart, so a request that outlived
    // one could never be answered.
    const [asksBySession, setAsksBySession] = useState<Record<string, string[]>>({});
    const [error, setError] = useState<string | null>(null);

// What actually gets sent for the current model: its remembered pick, else its
// own default, and null for a model that takes no effort flag at all.
const model = models.find((m) => m.id === modelId) ?? null;
const effort: Effort | null = model
  ? model.efforts.length
    ? effortByModel[modelId] ?? model.defaultEffort ?? DEFAULT_EFFORT
    : null
  : effortByModel[modelId] ?? null;

// A null effort means "just switch to this model" — it must leave the model's
// remembered pick alone, or coming back to Sonnet would lose the Extra High set
// on it earlier. Only an explicit level writes to the map.
const handleModelChange = (nextModelId: ModelId, nextEffort: Effort | null) => {
  setModelId(nextModelId);
  // Filed under the harness on screen, which is the only one that could have
  // offered this model — so coming back to that agent finds this pick rather
  // than whatever the other agent was left on.
  const byHarness = { ...prefs.modelByHarness, [harness]: nextModelId };
  if (nextEffort) {
    const next = { ...effortByModel, [nextModelId]: nextEffort };
    setEffortByModel(next);
    setPrefs({ modelByHarness: byHarness, effortByModel: next });
    return;
  }
  setPrefs({ modelByHarness: byHarness });
};

// Wrapped like the rest: which agent you work in is a preference, not a
// per-session accident.
//
// The model moves with it, from that harness's own remembered pick. Leaving it
// to the fetch effect below was the bug: that only ever *repairs* a pick the
// new harness cannot run, and its fallback is whatever leads the list, so
// switching agent and back landed on Fable or Sol however deliberately the
// reader had chosen otherwise.
const setHarness = (next: Harness) => {
  setHarnessState(next);
  setModelId(rememberedModel(prefs.modelByHarness, next));
  setPrefs({ harness: next });
};

// Wrapped rather than exported raw: picking a mode is a preference, and the
// hotkey in App.tsx goes through here too.
const setPermissionMode = (mode: ApprovalPolicy) => {
  setPermissionModeState(mode);
  setPrefs({ permissionMode: mode });
};

// Sticky, unlike before. Someone who works in worktrees works in worktrees; the
// old reset-to-off made them re-toggle it for every single task.
//
// Resolved against the rendered value rather than inside the state updater: React
// may run an updater twice, and writing the preference from in there would fire
// the side effect twice with it.
const setUseWorktree = (next: boolean | ((prev: boolean) => boolean)) => {
  const resolved = typeof next === "function" ? next(useWorktree) : next;
  setUseWorktreeState(resolved);
  setPrefs({ useWorktree: resolved });
};

// Attaching a known project just selects it, so this doubles as "switch to one
// I already have" without the picker growing duplicates.
const handleAttachProject = async () => {
  const picked = await open({ directory: true, multiple: false });
  if (typeof picked !== "string") return;

  try {
    // Returns the list already sorted, so the attached project is at the front.
    setProjects(await invoke<Project[]>("add_project", { path: picked }));
    setProjectPath(picked);
  } catch (e) {
    setError(String(e));
  }
};

const handleSelectProject = (path: string) => {
  setProjectPath(path);
  // Fire and forget: losing the remembered pick costs one dropdown next launch.
  void invoke("set_last_selected_project", { path }).catch(() => {});
};

// Checks the branch out for real, so the picker is the only thing that moves the
// working tree — by send time the repo is already where the session expects it.
const runCheckout = async (target: string, stash: boolean) => {
  if (!projectPath) return;

  try {
    const list = await invoke<BranchList>("checkout_branch", {
      cwd: projectPath,
      branch: target,
      stash,
    });
    setBranches(list);
    setBranch(list.current);
  } catch (e) {
    // Git refuses rather than clobbering, so the tree is untouched and the
    // message names the files in the way.
    setError(String(e));
  } finally {
    setPendingBranch(null);
  }
};

// A clean tree switches silently; a dirty one routes through the dialog, whose
// buttons call back into `runCheckout` with the user's choice.
//
// The dirty count is re-read here rather than taken from `branches`: that was
// fetched when the project was selected, and the user has been editing files
// since. A stale zero silently skips the dialog and moves their work.
const handleSelectBranch = async (target: string) => {
  if (!projectPath || target === branches?.current) return;

  let list: BranchList;
  try {
    list = await invoke<BranchList>("list_branches", { cwd: projectPath });
    setBranches(list);
  } catch (e) {
    setError(String(e));
    return;
  }

  if (list.dirty > 0) {
    setPendingBranch(target);
    return;
  }

  void runCheckout(target, false);
};

const selectedSession = selectedSessionId ? sessions.find((s) => s.sessionId === selectedSessionId) ?? null : null;

// Dedupes against the queued array, not the render snapshot: two fast clicks
// both miss an `existing` check made before their `await`, and would otherwise
// each append the same session.
const upsertSession = (snapshot: SessionSnapshot) =>
  setSessions((prev) =>
    prev.some((s) => s.sessionId === snapshot.sessionId)
      ? prev.map((s) => (s.sessionId === snapshot.sessionId ? snapshot : s))
      : [...prev, snapshot],
  );

const handleSendMsg = async (
  message: string,
  // Resolved, not paths, and only because a queued prompt needs them: the row
  // that draws it is handed these rather than describing its paths a second
  // time. The wire still takes paths alone.
  attachments: Attachment[] = [],
) => {
  const attachmentPaths = attachments.map((a) => a.path);

  let sessionId = selectedSessionId;
  const isNewSession = !sessionId;

  const existing = sessionId ? sessions.find((s) => s.sessionId === sessionId) : undefined;
  // The backend reads the recorded cwd on resume, so this only has to be right
  // for a new session.
  const cwd = isNewSession ? projectPath : existing?.cwd ?? projectPath;

  if (!cwd) {
    setError("Attach a project first.");
    return;
  }

  if (!sessionId) {
    sessionId = crypto.randomUUID();
    // Claimed alongside the selection everywhere it moves, or a read still out
    // from an earlier click can land afterwards and roll this one away.
    selectionRequestRef.current = sessionId;
    setSelectedSessionId(sessionId);
  }

  setError(null);
  // Read before the optimistic write below overwrites it. A send onto a running
  // turn must not release that turn's status if it fails — the turn is still
  // running, and the failure was this prompt's alone.
  const wasBusy = statusBySession[sessionId] === "in_progress";
  // Optimistic: the backend publishes the same transition once the prompt
  // reaches the child, but the composer must read busy the moment Enter lands.
  setStatusBySession((prev) => ({ ...prev, [sessionId]: "in_progress" }));
  // Optimistic for the same reason, and it covers a window the CLI cannot: a
  // new session has to spawn a process before it can announce anything, so the
  // first `model_request_started` is a cold start away.
  setWorkingBySession((prev) => ({ ...prev, [sessionId]: { tokens: 0 } }));

  try {
    const outcome = await invoke<SendOutcome>("send_msg", {
      sessionId,
      prompt: message,
      attachmentPaths,
      harness,
      model: modelId,
      effort,
      permissionMode,
      cwd,
      // Recorded, not acted on — the picker already checked it out. Null for a
      // worktree session, whose branch the CLI names itself.
      branch: isNewSession && !useWorktree ? branch : null,
      useWorktree: isNewSession && useWorktree,
      worktreeName: null,
      isNewSession,
    });

    // A turn was already running, so the prompt is held rather than sent. It
    // draws as pending until the backend hands it to the CLI, which arrives as
    // an ordinary `user_message` and retires it below. The status is already
    // `in_progress` and stays that way — the turn it was queued onto is the one
    // still running.
    // Applied on every path below, queued included. A `#DRA-53` is expanded
    // and recorded whether the prompt is sent or held, so the panel's Issue tab
    // must not wait on a boundary — or on a reselect — to show what the session
    // is now about. The backend answers with the list *as written*, because
    // re-tagging replaces an entry rather than appending one.
    const applySentIssues = () => {
      setSessionIndexItems((prev) =>
        prev.map((i) => (i.sessionId === sessionId ? { ...i, issues: outcome.issues } : i)),
      );
      setSessions((prev) =>
        prev.map((s) => (s.sessionId === sessionId ? { ...s, issues: outcome.issues } : s)),
      );
    };

    if (outcome.queued) {
      const queued = outcome.queued;
      setQueuedBySession((prev) => ({
        ...prev,
        [sessionId]: [...(prev[sessionId] ?? []), { message: queued, attachments }],
      }));
      applySentIssues();
      return;
    }

    const { snapshot } = outcome;

    // Only a new session yields a snapshot. Built by the backend, so the resolved
    // worktree name and truncated title come from disk rather than a guess here.
    if (snapshot) {
      upsertSession(snapshot);
      // A new session is never archived, so it belongs to the active list only —
      // pushed unconditionally it would show up under the archived filter too.
      if (!showArchived) {
        setSessionIndexItems((prev) => [...prev, snapshot]);
      }
      return;
    }

    // The backend just bumped `modified` and the model on an existing session's
    // index entry; mirror it so the sidebar doesn't need a refetch.
    setSessionIndexItems((prev) =>
      prev.map((i) =>
        i.sessionId === sessionId
          ? { ...i, model: modelId, effort, permissionMode, modified: new Date().toISOString() }
          : i,
      ),
    );
    applySentIssues();
  } catch (e) {
    // A rejected invoke means the turn never started, so nothing will arrive to
    // clear the status — release it here rather than leaving the composer stuck.
    // Unless a turn was already running: that one is untouched by this prompt
    // failing, and clearing it would strand a live session as idle.
    if (!wasBusy) {
      setStatusBySession((prev) => ({ ...prev, [sessionId]: "idle" }));
      setWorkingBySession((prev) => ({ ...prev, [sessionId]: null }));
    }
    setError(String(e));
  }
};

// Takes back the newest prompt still waiting on the backend and hands its text
// to the caller, which is the composer putting it back where it was typed.
//
// Newest-first because that is the one just typed. `null` means the flush won —
// past that the CLI owns the prompt and no channel exists to retract it, so the
// composer is left alone and the message lands as an ordinary one.
const handleCancelQueued = async (): Promise<QueuedMessage | null> => {
  if (!selectedSessionId) return null;
  const sessionId = selectedSessionId;
  try {
    const cancelled = await invoke<QueuedMessage | null>("cancel_queued", { sessionId });
    // Nothing to take back, so what is drawn is a row the backend no longer
    // holds — a prompt whose delivery failed before it could mint the event
    // that retires it, or a queue that died with its child. Cleared rather than
    // left: it is a row whose Esc provably does nothing.
    if (!cancelled) {
      setQueuedBySession(({ [sessionId]: _, ...rest }) => rest);
      return null;
    }
    // What was attached goes back with the sentence it was attached to, or a
    // cancel keeps the files silently — the tray was cleared on send and
    // nothing else holds them. Synchronous, so an Enter pressed straight after
    // Esc cannot send that sentence without them.
    const held = (queuedRef.current[sessionId] ?? []).find(
      (q) => q.message.id === cancelled.id,
    );
    if (held) restoreAttachments(sessionId, held.attachments);

    setQueuedBySession((prev) => ({
      ...prev,
      [sessionId]: (prev[sessionId] ?? []).filter((q) => q.message.id !== cancelled.id),
    }));
    return cancelled;
  } catch (e) {
    setError(String(e));
    return null;
  }
};

// Signals the CLI to abort the in-flight turn; the session stays alive. Status
// is not touched here — the abort produces a result event, and the backend's
// machine reports the transition on `session_status` like any other ending.
const handleInterrupt = async () => {
  if (!selectedSessionId) return;
  try {
    await invoke("interrupt_session", { sessionId: selectedSessionId });
  } catch (e) {
    setError(String(e));
  }
};

// Stops one background task. Nothing is written to local state: the CLI
// republishes the task set and files a `task_notification` of its own, which is
// what settles the panel row and lets the status machine finish the session.
//
// Not covered by `handleInterrupt` — an interrupt with no turn in flight is
// acked and changes nothing, which is precisely the state a background task
// leaves a session in.
const handleStopTask = async (taskId: string) => {
  if (!selectedSessionId) return;
  try {
    await invoke("stop_task", { sessionId: selectedSessionId, taskId });
  } catch (e) {
    setError(String(e));
  }
};

// Answers a permission request the agent is blocked on. The decision comes back
// as an event like any other, so nothing is written to local state here — the
// card learns it was answered from the transcript, the same way a reload does.
//
// `optionId` is opaque on purpose: the standing rule behind it lives in the
// backend, so the frontend can neither widen a grant nor invent one.
const handleRespondPermission = async (requestId: string, optionId: string) => {
  if (!selectedSessionId) return;
  try {
    await invoke("respond_permission", {
      sessionId: selectedSessionId,
      requestId,
      optionId,
    });
  } catch (e) {
    setError(String(e));
  }
};

const handleAnswerQuestions = async (
  requestId: string,
  answers: Record<string, string>,
) => {
  if (!selectedSessionId) return;
  try {
    await invoke("answer_questions", {
      sessionId: selectedSessionId,
      requestId,
      answers,
    });
  } catch (e) {
    setError(String(e));
  }
};

// Restores the user's own defaults, not the app's. Selecting a session overwrote
// the live controls with that session's settings, so every field they can change
// has to be put back from prefs here — otherwise the last session clicked in the
// sidebar silently becomes the template for the next new one.
//
// Branch is the exception: it seeds from whatever the repo is checked out to,
// since the picker is the only thing that moves the tree and a remembered name
// would either be a lie or an unasked-for checkout.
const handleNewSession = () => {
  selectionRequestRef.current = null;
  setSelectedSessionId(null);
  setHarnessState(prefs.harness);
  // Repaired against the list on screen, not taken as read. The effect below
  // only fires when the harness *changes*, so a stored model left over from the
  // other harness would come back here untouched every time — and the harness
  // is stored too, so the two can disagree from the moment one is picked
  // without the other.
  setModelId(
    usableModel(models, rememberedModel(prefs.modelByHarness, prefs.harness), prefs.harness),
  );
  setEffortByModel(prefs.effortByModel);
  setPermissionModeState(prefs.permissionMode);
  setUseWorktreeState(prefs.useWorktree);
  setBranch(branches?.current ?? null);
};

// Puts the composer's controls back to what the session was started with. Every
// setter here is the raw state setter, never the prefs-writing wrapper: these
// values are the session's, not the user's choice, and moving between sessions
// must not rewrite the defaults that `handleNewSession` reads back.
//
// Takes the item rather than an id because a fork's row does not reach
// `sessionIndexItems` until the render after it is made, and it needs this on
// the way in like any other session being opened.
//
// Project, branch, and the worktree flag aren't restored — the composer hides
// all three once a session exists, and they'd only mislead the next new chat.
const restoreSessionControls = (item: SessionIndexItem) => {
  // The raw setter, like the rest of this function: a session's harness is the
  // session's, and clicking through old ones must not rewrite the default.
  setHarnessState(item.harness);
  // A session indexed before the model was recorded, or one whose id this build
  // cannot name, reads back as the unset sentinel. Answered from the session's
  // own harness, since a model belongs to exactly one — and for a harness that
  // names no default the sentinel stands, which is what the picker reads as
  // "not chosen yet".
  const restored = isUnsetModel(item.model) ? DEFAULT_MODEL_FOR[item.harness] : item.model;
  setModelId(restored);
  // The index stores one model/effort pair, so it can only seed that model's
  // entry; the rest of the map falls back to per-model defaults.
  if (item.effort) {
    setEffortByModel((prev) => ({ ...prev, [restored]: item.effort! }));
  }
  setPermissionModeState(item.permissionMode);
};

const handleSelectSessionIndexItem = async (sessionId: string) => {
  // Claimed synchronously, so a click arriving during the read below is visible
  // to it immediately. The rendered selection cannot serve here — it is a render
  // behind, so a read finishing in that gap would still see itself as current.
  selectionRequestRef.current = sessionId;

  // Where the reader was, for the case the id turns out to resolve to nothing.
  // Whether it is still somewhere they can be put back is decided at the
  // rollback itself, not here — see there.
  const previous = selectedSessionIdRef.current;

  setSelectedSessionId(sessionId);

  // Opening the session is answering the notice about it — an unread completion
  // is read, and a pending request is now on screen. Not the ready-to-merge
  // card, which asks the reader to look at something a session's transcript
  // does not show; see `ANSWERED_BY_OPENING`.
  dismissNotice(sessionId, ANSWERED_BY_OPENING);

  // Opening a finished session is reading it.
  const clicked = sessionIndexItems.find((i) => i.sessionId === sessionId);
  if ((statusBySession[sessionId] ?? clicked?.status) === "completed") {
    markSessionRead(sessionId);
  }

  const indexItem = sessionIndexItems.find((i) => i.sessionId === sessionId);
  if (indexItem) {
    restoreSessionControls(indexItem);
  }

  if (sessions.some((s) => s.sessionId === sessionId)) {
    return;
  }

  try {
    const snapshot = await invoke<SessionSnapshot | null>("get_session_by_id", { sessionId });
    if (snapshot) {
      upsertSession(snapshot);
      return;
    }

    // The id resolves to nothing on disk, so the selection has to go back where
    // it was. Leaving it is not the harmless-looking half-state it reads as:
    // `selectedSession` would be null while `selectedSessionId` still held the
    // dead id, and both `centered` and `isNewTask` derive from that null — so
    // the reader gets the *new task* composer while `handleSendMsg` still finds
    // an id, computes `isNewSession: false`, and resumes a session that is gone.
    //
    // Reached by a relayed message naming a sender since deleted: the
    // attribution is persisted deliberately, and the session it points at need
    // not outlive it. A sidebar row can go stale the same way.
    //
    // Only when this read is still the one being waited on. A click that landed
    // while it was out has already claimed the request, and rolling back onto
    // this answer would take the reader off the session they just asked for.
    if (selectionRequestRef.current !== sessionId) return;

    // Only a session still loaded can be gone back to, and that is judged here
    // rather than before the read, for two reasons that both end in this same
    // dead end. The selection this started from is *optimistic* until its own
    // read lands, so it may itself be an id about to be rolled back; and a
    // session that was loaded when this began can be deleted while the read is
    // out, which `deleteSession` does not clear the selection for unless that
    // session was the one selected — and by here it is not.
    //
    // Nothing to go back to leaves `null`, the empty composer. Not where the
    // reader asked to be, but a state they can act from.
    const restorable =
      previous && sessionsRef.current.some((s) => s.sessionId === previous)
        ? previous
        : null;

    selectionRequestRef.current = restorable;
    setSelectedSessionId(restorable);
    // Not "deleted": all this knows is that the id resolved to nothing, and
    // deletion is the likely cause rather than the observed one.
    setError("Session not found.");
  } catch (e) {
    setError(String(e));
  }
}



// One call for both flags, so a click writes only the one it owns. The row is
// replaced from what the store returned rather than from the value we sent —
// the index is authoritative, and a failed write must not leave the sidebar
// showing a state the disk doesn't have.
/// Cuts a spawned session loose from its parent, so the sidebar stops nesting
/// it under a row it no longer belongs to.
///
/// The row is replaced from what the backend returned rather than from a local
/// edit, for `setSessionFlags`' reason: the index is authoritative, and a
/// failed write must not leave the sidebar drawing a state the disk doesn't
/// have. Nothing re-parents — detaching is one-way.
const detachSession = async (sessionId: string) => {
  try {
    const updated = await invoke<SessionIndexItem | null>("detach_session", {
      sessionId,
    });
    if (!updated) return;
    setSessionIndexItems((prev) =>
      prev.map((i) => (i.sessionId === sessionId ? updated : i)),
    );
  } catch (e) {
    setError(String(e));
  }
};

/// Writes a session's settled or pinned flag, and answers whether it landed.
///
/// The answer is what callers navigate on. A failed write leaves the row where
/// it was, so acting anyway — following it to the other view, celebrating a
/// settle that did not happen — describes a move the index never made.
const setSessionFlags = async (
  sessionId: string,
  flags: { archived?: boolean; pinned?: boolean },
): Promise<boolean> => {
  try {
    const updated = await invoke<SessionIndexItem | null>("set_session_flags", {
      sessionId,
      archived: flags.archived ?? null,
      pinned: flags.pinned ?? null,
    });
    // Null is the backend finding no such session, which is a write that did
    // not happen like any other.
    if (!updated) return false;
    setSessionIndexItems((prev) => {
      // The ref, not the closure: this runs after the write, and the reader can
      // toggle the split while one is in flight. Judged against the captured
      // value it would sort the row into whichever view was open when the
      // button was pressed — dropping it from the list now on screen, or
      // inserting a settled row into the active one.
      const belongsHere = updated.archived === showArchivedRef.current;
      // The row can be written from a view it was never drawn in: the settled
      // split keeps the selection across a toggle, so the composer's unsettle
      // bar is reachable while the sidebar is showing the active list. Left to
      // the map below that write lands nowhere — the row is in neither list,
      // and the session the reader just took back has no row at all until
      // something else refetches.
      if (belongsHere && !prev.some((i) => i.sessionId === sessionId)) {
        return [...prev, updated];
      }

      return prev.flatMap((i) => {
        if (i.sessionId !== sessionId) return [i];
        // Archiving from the active list — or unarchiving from the archived one —
        // moves the row to the other view, so it leaves this one rather than
        // sitting there contradicting the filter that produced the list.
        return belongsHere ? [updated] : [];
      });
    });
    // The open transcript keeps its own copy of the index fields, and it's what
    // the composer reads `archived` from — left alone, settling the session on
    // screen would swap in the unsettle bar only after a reselect.
    setSessions((prev) =>
      prev.map((s) =>
        s.sessionId === sessionId
          ? { ...s, archived: updated.archived, pinned: updated.pinned }
          : s,
      ),
    );
    return true;
  } catch (e) {
    setError(String(e));
    return false;
  }
};

// Applies whatever a link write answered with to both copies of the session.
//
// Two copies, for `setSessionFlags`' reason: the sidebar reads the index items
// and the open transcript holds its own flattened copy, which is what the panel
// and its tab are drawn from. Leaving either behind shows an issue that is no
// longer linked, or hides one that is.
const applyIssues = (sessionId: string, issues: IssueRef[]) => {
  setSessionIndexItems((prev) =>
    prev.map((i) => (i.sessionId === sessionId ? { ...i, issues } : i)),
  );
  setSessions((prev) =>
    prev.map((s) => (s.sessionId === sessionId ? { ...s, issues } : s)),
  );
};

// Removes one. `key` is the tracker's own id from the row that was clicked; the
// backend also accepts the human identifier, which is what the CLI passes.
const unlinkIssue = async (sessionId: string, key: string) => {
  try {
    applyIssues(sessionId, await invoke<IssueRef[]>("unlink_issue", { sessionId, key }));
  } catch (e) {
    setError(String(e));
  }
};

// The half of the removal that can only run once git has answered: the
// relocated entry, applied to both copies of the session.
const applyWorktreeRemoval = (sessionId: string, updated: SessionIndexItem) => {
  // A retry that worked retires the card that reported the first attempt.
  // Reachable without going through it: the failure leaves the settled bar's
  // own button on screen, so the reader can press that instead of View, and
  // the card would sit there for the rest of its fifteen seconds still saying
  // the cleanup failed.
  dismissNotice(sessionId, "worktree-failed");

  setSessionIndexItems((prev) =>
    prev.map((i) => (i.sessionId === sessionId ? updated : i)),
  );
  // The open transcript holds its own copy of these fields, and `cwd` is the
  // one that matters: the changes panel and the PR tab both read it, and left
  // pointing into the deleted tree they would read a directory that is gone.
  // Copied off the write rather than restated here — spelling the relocation
  // out a second time is how this and the index drift, and it had: `branch`
  // was cleared here while the entry on disk keeps `worktree-<name>` for the
  // PR tab to find its PR by.
  setSessions((prev) =>
    prev.map((s) =>
      s.sessionId === sessionId
        ? {
            ...s,
            cwd: updated.cwd,
            worktreeName: updated.worktreeName,
            worktreeRemoved: updated.worktreeRemoved,
            branch: updated.branch,
          }
        : s,
    ),
  );
  // A killed child leaves no `session_status`, so the sidebar would sit on
  // whatever it last saw — `in_progress` for a session that was mid-turn.
  setStatusBySession((prev) => ({ ...prev, [sessionId]: "idle" }));
};

// Takes back the "Deleted" the reader has already been shown.
//
// A card rather than the error banner, which is where this used to go and can
// no longer carry it: that banner is drawn above the composer, and a settled
// session draws the settled bar instead — so the one state this can be reached
// from is the one state the banner is not on screen in.
//
// **It says the cleanup failed, not that the tree is still there**, and the
// difference is the whole of the copy. The removal is a run of steps and any of
// them can be the one that answers: git refusing leaves the directory, but the
// index write is *last*, so a failure there is a tree already deleted and a
// session that was never moved off it. Naming the outcome would mean naming
// which step, which the backend does not report; naming the operation is true
// of every one of them.
//
// `reason` is the backend's own sentence and the whole of the detail line — the
// only thing that says which step this was. The button is the nearest thing to
// a cure: the entry is only cleared by that last step, so the settled bar is
// still carrying the control that runs the rest, whichever end it stopped at.
const reportWorktreeFailure = (sessionId: string, title: string, reason: string) => {
  pushNotice({
    sessionId,
    kind: "worktree-failed",
    // The news, not an action: there is nothing here for the reader to decide,
    // and a card that opened with a verb would be asking them to.
    label: "Worktree cleanup failed",
    subject: title,
    detail: reason,
  });
};

// Deletes the worktree a session was running in, keeping the session. The
// backend kills the child, removes the tree and its branch, and relocates the
// index entry to the project root; the row is replaced from what it returns,
// for the reason `setSessionFlags` above gives.
//
// The relocated item no longer carries a `worktreeName`, which is what retires
// every control that offers this — the button disappears because the thing it
// acted on is gone, rather than because anything tracks that it was pressed.
//
// **Started, not awaited.** Unlocking the tree, removing it and deleting its
// branch is three git commands over a directory that can be large, and both
// callers have something better to say than "wait": the dialog closes and the
// card goes to "Deleted". So this returns as soon as the work is under way,
// and the two things that can only be known later — the relocated row, and a
// refusal — arrive on their own.
//
// `origin` is who asked, and all it decides is whether a failure is reported.
// `"asked"` means the reader pressed something — a button, a card, or one that
// skipped its confirm because the tree had already gone — so they are owed the
// answer, whether that is the close they saw or a card taking it back.
// `"tidy"` is the app's own pass on settle over a worktree that was not there:
// nothing was drawn and nothing was promised, and the session was pointing at a
// missing directory before this ran, so a card would raise a state the reader
// has never seen and cannot act on.
const removeWorktree = (sessionId: string, origin: "asked" | "tidy" = "asked") => {
  // A second press cannot be allowed through, and the window this opened is
  // why. The row keeps its "Delete worktree" button until the write lands, so
  // the same tree can be asked for twice — and the second call, arriving after
  // the first relocated the entry, is refused with "that session is not running
  // in a worktree". That is a cleanup that worked, reported to the reader as
  // one that failed, which is the failure `merge_pr` re-reads the pull request
  // to avoid.
  //
  // **Held for good on success, not until the promise settles.** Clearing it
  // there looks equivalent and is a frame early: React schedules the re-render
  // that retires the button, so the button outlives the guard by however long
  // that takes to commit — which is the exact window above, still open. Nothing
  // is leaked by keeping it, because `worktree_name` is written at creation and
  // at fork and cleared in one place, so a session that has been relocated can
  // never want this again.
  if (removingWorktrees.has(sessionId)) return;
  removingWorktrees.add(sessionId);

  // Read now rather than on the way out: by the time a refusal lands the row
  // may have moved, and the title is what says which session the card is about.
  const title = sessionIndexItems.find((i) => i.sessionId === sessionId)?.title ?? "";

  void invoke<SessionIndexItem>("remove_session_worktree", { sessionId })
    // Two callbacks rather than `.then(…).catch(…)`, so the failure card can
    // only ever report the backend refusing. Chained, a throw out of the write
    // above would land in the same handler and be described as a cleanup that
    // failed, when it was the one thing here that succeeded.
    .then(
      (updated) => applyWorktreeRemoval(sessionId, updated),
      (e) => {
        // Cleared only here. A failure is the one outcome that wants pressing
        // again, and every other path leaves the entry claimed for good — see
        // above for why that is the right length to hold it.
        removingWorktrees.delete(sessionId);
        if (origin === "asked") reportWorktreeFailure(sessionId, title, String(e));
      },
    );
};

// Copies a session onto a new id so it can be carried on in two directions at
// once. The id is minted here for the same reason a new session's is — this app
// chooses session ids and the CLI adopts them.
//
// Selected on arrival, since forking is asking to work in the copy. Nothing
// spawns yet: the backend leaves the CLI's own fork for the first send, and the
// snapshot it returns is the parent's copied log, so the new session opens
// reading exactly like the one it came from.
const forkSession = async (sessionId: string, worktree: boolean) => {
  const forkId = crypto.randomUUID();

  let snapshot: SessionSnapshot;
  try {
    snapshot = await invoke<SessionSnapshot>("fork_session", {
      sessionId,
      forkId,
      worktree,
    });
  } catch (e) {
    setError(String(e));
    return;
  }

  setError(null);
  upsertSession(snapshot);
  // A fork is never archived, so it belongs to the active list alone — pushed
  // unconditionally it would show up under the archived filter too.
  if (!showArchived) {
    setSessionIndexItems((prev) => [...prev, snapshot]);
  }
  setSelectedSessionId(snapshot.sessionId);
  restoreSessionControls(snapshot);
};

// Removes the session everywhere it's held, backend first: the row must not
// disappear before the disk agrees, or a failed delete leaves the sidebar
// missing a session that is still there on the next launch.
//
// Deleting the open one falls back to the empty composer rather than to a
// neighbour — the next session is not a guess worth making, and `handleNewSession`
// is the one path that also restores the user's own defaults.
const deleteSession = async (sessionId: string) => {
  try {
    await invoke<boolean>("delete_session", { sessionId });
  } catch (e) {
    setError(String(e));
    return;
  }

  setSessionIndexItems((prev) => prev.filter((i) => i.sessionId !== sessionId));
  setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
  setStreamingContentBlock(({ [sessionId]: _, ...rest }) => rest);
  setStatusBySession(({ [sessionId]: _, ...rest }) => rest);
  setWorkingBySession(({ [sessionId]: _, ...rest }) => rest);
  setTasksBySession(({ [sessionId]: _, ...rest }) => rest);
  setQueuedBySession(({ [sessionId]: _, ...rest }) => rest);

  if (selectedSessionId === sessionId) {
    handleNewSession();
  }
};

// Refetched on every toggle rather than filtered from one cached list: the two
// views are disjoint, so holding both would mean tracking which of them a flag
// write belongs to.
useEffect(() => {
  invoke<SessionIndexItem[]>("list_session_index_items", { archived: showArchived })
    .then(setSessionIndexItems)
    .catch((e) => setError(String(e)));
}, [showArchived])

useEffect(() => {
  invoke<Model[]>("list_models", { harness }).then((list) => {
    setModels(list);
    // A model belongs to exactly one harness, so switching harness leaves the
    // pick naming something the new one cannot run. Repaired here, where the
    // real list has just landed, rather than guessed at when the toggle moved.
    setModelId((current) => usableModel(list, current, harness));
  });
}, [harness])

useEffect(() => {
  invoke<Project[]>("list_projects")
    .then((list) => {
      setProjects(list);
      // Sorted most-recently-selected first, so the front of the list *is* the
      // project to reopen — no separate pointer to keep in step.
      setProjectPath(list[0]?.path ?? null);
    })
    // Without this a failed read leaves the picker silently empty, and the
    // reason only reaches the console.
    .catch((e) => setError(String(e)));
}, [])

// Refetched per project rather than cached: branches change outside the app.
// The guard matters because switching projects quickly would otherwise let a
// slower repo's response land on top of the faster one's.
useEffect(() => {
  if (!projectPath) {
    setBranches(null);
    setBranch(null);
    return;
  }

  let cancelled = false;

  invoke<BranchList>("list_branches", { cwd: projectPath })
    .then((list) => {
      if (cancelled) return;
      setBranches(list);
      setBranch(list.current);
    })
    .catch((e) => {
      if (cancelled) return;
      // Cleared rather than left stale: the picker would otherwise offer the
      // previous project's branches for this one.
      setBranches(null);
      setBranch(null);
      setError(String(e));
    });

  return () => {
    cancelled = true;
  };
}, [projectPath])

useEffect(() => {
  const setupListener = async () => {
    const unlisten = await listen<AgentEvent>("agent_event", (event) => {
      // console.log(event);

      const agentEvent = event.payload;

        if (agentEvent.payload.type != "delta") {
            setSessions((prev) =>
            prev.map((s) =>
                s.sessionId === agentEvent.sessionId
                ? { ...s, events: [...s.events, agentEvent] }
                : s,
            ),
            );

            // A held prompt reached the CLI, so the pending row it was drawn as
            // gives way to the real one now in the transcript. Matched by
            // position rather than by id — the flush delivers oldest-first and
            // the event carries the event's own id, not the queue entry's — so
            // dropping the head is exact.
            if (
              agentEvent.payload.type === "user_message" &&
              agentEvent.payload.queued
            ) {
              setQueuedBySession((prev) => {
                const cur = prev[agentEvent.sessionId];
                if (!cur?.length) return prev;
                return { ...prev, [agentEvent.sessionId]: cur.slice(1) };
              });
            }

            // The committed event supersedes its preview, and it arrives one
            // line *before* `block_stop` — so waiting for the stop leaves both
            // on screen for a frame, the preview shoved down by the event that
            // just replaced it. Retiring the preview here puts both writes in
            // one listener call, which React batches into a single render.
            const streamingBlockRef =
              (agentEvent.payload.type === "assistant_text" ||
                agentEvent.payload.type === "reasoning") &&
              agentEvent.payload.block;

            if (streamingBlockRef) {
              setStreamingContentBlock((prev) => {
                const cur = prev[agentEvent.sessionId];
                // Index alone: the CLI runs one block at a time, but a stale
                // preview from an earlier message would share indices.
                if (!cur || cur.index !== streamingBlockRef.index) return prev;
                return { ...prev, [agentEvent.sessionId]: null };
              });
            }

            // `tool_call_started` carries no `BlockRef` — the mapper builds it
            // from the committed `assistant` message rather than from the stream
            // — so the preview is retired on the tool_use id the two do share.
            // Here rather than on `block_stop` for the same reason as above: the
            // stop lands ~20ms later, and waiting for it draws both rows for a
            // frame with the preview shoved down by its own replacement.
            if (agentEvent.payload.type === "tool_call_started") {
              const { callId } = agentEvent.payload;
              setStreamingContentBlock((prev) => {
                const cur = prev[agentEvent.sessionId];
                if (!cur || cur.callId !== callId) return prev;
                return { ...prev, [agentEvent.sessionId]: null };
              });
            }

            // The CLI announces a model request within 30ms of every tool
            // result, and again at the top of each turn — so this marks the
            // start of every blank stretch, which is what the old "nothing has
            // rendered yet" rule could only approximate.
            if (agentEvent.payload.type === "model_request_started") {
              setWorkingBySession((prev) => ({
                ...prev,
                [agentEvent.sessionId]: { tokens: 0 },
              }));
            }

            // A thinking block reports its size on `usage_update` and nowhere
            // else. Only a non-null reading counts: the same payload carries
            // every other usage field, so a turn-level update would otherwise
            // reset the counter to zero mid-thought.
            if (agentEvent.payload.type === "usage_update") {
              const { reasoningTokens } = agentEvent.payload;
              if (reasoningTokens !== null) {
                setWorkingBySession((prev) => {
                  const cur = prev[agentEvent.sessionId];
                  if (!cur) return prev;
                  return {
                    ...prev,
                    [agentEvent.sessionId]: { ...cur, tokens: reasoningTokens },
                  };
                });
              }
            }

            // The turn is over whether or not a block ever opened.
            if (agentEvent.payload.type === "turn_completed") {
              setWorkingBySession((prev) => ({ ...prev, [agentEvent.sessionId]: null }));
            }

            // Republished whole on every change, so the latest set replaces
            // rather than merges. The backend mints an empty one when the child
            // exits, which is what clears a dead child's tasks from here.
            if (agentEvent.payload.type === "background_tasks_changed") {
              const { tasks } = agentEvent.payload;
              setTasksBySession((prev) => ({ ...prev, [agentEvent.sessionId]: tasks }));
              // The other half of the guard in `session_status`: a turn that
              // ended with a task still open kept its asks, since the task's
              // subagent could be the one asking. With the set drained and no
              // turn running, nothing is left that could answer them.
              if (
                tasks.length === 0 &&
                statusBySessionRef.current[agentEvent.sessionId] !== "in_progress"
              ) {
                setAsksBySession((prev) =>
                  prev[agentEvent.sessionId]?.length
                    ? { ...prev, [agentEvent.sessionId]: [] }
                    : prev,
                );
              }
            }

            // The agent has stopped and is waiting on the reader. Announced like
            // a completion because it is the same kind of news — the difference
            // is that this one holds the turn until it is answered, which is why
            // its notice does not time out.
            if (
              agentEvent.payload.type === "permission_requested" ||
              agentEvent.payload.type === "questions_asked"
            ) {
              const { requestId } = agentEvent.payload;
              const asking =
                agentEvent.payload.type === "questions_asked"
                  ? "Needs an answer"
                  : "Needs permission";

              setAsksBySession((prev) => {
                const cur = prev[agentEvent.sessionId] ?? [];
                if (cur.includes(requestId)) return prev;
                return { ...prev, [agentEvent.sessionId]: [...cur, requestId] };
              });
              announce(agentEvent.sessionId, "asking", asking);
            }

            // The card is answered, so both the rail mark and the notice
            // pointing at it have nothing left to point at.
            if (agentEvent.payload.type === "permission_decided") {
              const { requestId } = agentEvent.payload;
              setAsksBySession((prev) => {
                const cur = prev[agentEvent.sessionId];
                if (!cur?.length) return prev;
                return {
                  ...prev,
                  [agentEvent.sessionId]: cur.filter((id) => id !== requestId),
                };
              });
              dismissNotice(agentEvent.sessionId, "asking");
            }

            // Busy is no longer inferred from `turn_completed` here: a result
            // can land while a background subagent is still running, so the
            // backend's status machine owns the call and reports it on the
            // `session_status` channel instead.
            if (agentEvent.payload.type === "error") {
              setError(agentEvent.payload.message);
            }
        } else {
            const payload = agentEvent.payload;

            const sessionId = agentEvent.sessionId;

            // A subagent's stream is not this conversation's. There is one
            // preview per session, so its text landed in the main transcript,
            // streamed to the end, then vanished when the committed message
            // filed itself under the run — and the primary agent's reply began
            // streaming into the space it left. Claude Code sends no deltas for
            // subagent output at all, which is why this only ever showed up
            // under Codex, where the whole run arrives on the same connection.
            //
            // Dropped rather than routed: the panel draws the committed message
            // and has no preview of its own to feed.
            if (agentEvent.subagent) return;

            if (payload.delta == "block_start") {
                // Which kind opens decides whether the wait is over. Text and a
                // tool call both start drawing immediately, so the indicator
                // steps aside; a thinking block draws nothing at all, so the
                // wait continues under a name it can finally be given. The
                // counter restarts here — `usage_update` reports the block's own
                // size, not a running session total.
                setWorkingBySession((prev) =>
                  payload.blockType.type === "thinking"
                    ? { ...prev, [sessionId]: { tokens: 0 } }
                    : { ...prev, [sessionId]: null },
                );

                // The block announces its kind up front — this is the only
                // frame that knows thinking from text, since thinking deltas
                // arrive as plain text_delta afterwards.
                setStreamingContentBlock((prev) => ({
                  ...prev,
                  [sessionId]: {
                    index: payload.block.index,
                    text: "",
                    type: payload.blockType.type,
                    // Carried rather than dropped: on a large `Write` this is the
                    // only thing identifying the call for the ~40s its arguments
                    // take to stream, and the row drawn from it is what stands in
                    // for the committed event that arrives at the end.
                    name: payload.blockType.type === "tool_use" ? payload.blockType.name : null,
                    callId: payload.blockType.type === "tool_use" ? payload.blockType.id : null,
                  },
                }));
            } else if (payload.delta == "text_delta") {
                setStreamingContentBlock((prev) => {
                  const cur = prev[sessionId];
                  if (!cur || cur.index !== payload.block.index) return prev;
                  return {
                    ...prev,
                    // Deltas append; the type stays what block_start declared.
                    // Stamping "text" here is what used to make streamed
                    // thinking render as assistant prose until it committed.
                    [sessionId]: { ...cur, type: cur.type ?? "text", text: cur.text + payload.text },
                  };
                });
            } else if (payload.delta == "input_delta") {
                setStreamingContentBlock((prev) => {
                  const cur = prev[sessionId];
                  if (!cur || cur.index !== payload.block.index) return prev;
                  return {
                    ...prev,
                    [sessionId]: {
                      ...cur,
                      text: cur.text + payload.partialJson,
                    },
                  };
                });
            } else if (payload.delta == "block_stop") {
                setStreamingContentBlock((prev) => ({ ...prev, [sessionId]: null }));
            } else {
                setStreamingContentBlock((prev) => ({ ...prev, [sessionId]: null }));
            }
        }

    });
    return unlisten;
  };

  const listenerPromise = setupListener();

  return () => {
    listenerPromise.then((unlisten) => unlisten());
  };
}, []);

/// The selection the reader last *asked* for, written at call time rather than
/// at render.
///
/// Not interchangeable with `selectedSessionIdRef` below, which mirrors state
/// and so lags a render behind: a click landing while a read is in flight has
/// already changed this, and has not yet changed that. Only this one can answer
/// "is my answer still the one being waited on", which is what stops a slow
/// read from overwriting a newer click.
const selectionRequestRef = useRef<string | null>(selectedSessionId);

// Inside the listener the closure would see the mount-time selection; the ref
// tracks the live one so "already being viewed" is judged against reality.
const selectedSessionIdRef = useRef(selectedSessionId);
selectedSessionIdRef.current = selectedSessionId;

// Same reason as the selection ref above: the status listener is registered
// once, so it needs the live index to name the session that just finished, and
// the live statuses to answer "is the one on screen still unread".
const sessionIndexItemsRef = useRef(sessionIndexItems);
sessionIndexItemsRef.current = sessionIndexItems;
const statusBySessionRef = useRef(statusBySession);
statusBySessionRef.current = statusBySession;
const tasksBySessionRef = useRef(tasksBySession);
tasksBySessionRef.current = tasksBySession;

// And again for the archived split: `session_created` is registered once, so
// without this it would judge every arriving session against whichever view was
// open at mount.
const showArchivedRef = useRef(showArchived);
showArchivedRef.current = showArchived;

/// The loaded sessions as of now, for the one reader that runs after an `await`
/// and so cannot trust the copy its closure captured. `deleteSession` empties a
/// row out of `sessions` without touching the selection unless that row *was*
/// the selection — so a session validated before a read can be gone by the time
/// the read answers.
const sessionsRef = useRef(sessions);
sessionsRef.current = sessions;

// `completed` means finished *and unread*. Reading is what retires it, so every
// path to a read funnels through here: the status landing on the session already
// on screen, the user clicking a finished one in the sidebar, and coming back to
// a window that finished its turn while it was in the background.
const markSessionRead = (sessionId: string) => {
  setStatusBySession((prev) => ({ ...prev, [sessionId]: "idle" }));
  // The notice and the unread dot report the same thing, so the read that
  // retires one retires the other.
  dismissNotice(sessionId, ANSWERED_BY_OPENING);
  // Cleared locally first — the click must feel instant. Losing the write
  // costs one stale unread dot after a restart, so a failure isn't surfaced.
  void invoke("mark_session_idle", { sessionId }).catch(() => {});
};

/// Tell the reader about something that happened in a session, on exactly one
/// channel, chosen by where they are. Returns whether they were already looking
/// at it — the one case nothing is raised, since the transcript itself is the
/// notification.
///
/// Shared by every announcement rather than repeated per event: a desktop banner
/// in front of someone looking at the window is an interruption, and an in-app
/// card is invisible from another app, so the split has to be made the same way
/// everywhere or one event ends up on two channels.
/// The two channels are told apart on purpose. A desktop banner lands in a
/// stack beside every other app's, so it has to name the session and the
/// project or it says nothing; the in-app card is the only card on screen next
/// to a sidebar already marking the row, so it needs the verb and nothing else.
const announce = (sessionId: string, kind: NoticeKind, label: string): boolean => {
  if (!isWindowFocused()) {
    const item = sessionIndexItemsRef.current.find((i) => i.sessionId === sessionId);

    // Same order as the card: the verb first, because *what is wanted* is the
    // one thing not on screen anywhere else. The session title follows as the
    // body — a banner lands in a stack beside every other app's, so it has to
    // say which session, where the card can lean on the sidebar rail for that.
    notifyOS(sessionId, kind, label, item?.title ?? "");
    return false;
  }
  if (sessionId === selectedSessionIdRef.current) return true;

  // The sound is the signal; the card is a thing to click. Fired side by side
  // rather than one from the other, so dropping either leaves the other
  // working.
  playNotification();
  pushNotice({ sessionId, kind, label });
  return false;
};

// Reading requires *looking*, which an unfocused window rules out however
// selected the session is. So the completion below only counts as read when the
// app has focus, and this covers the other half: the reader coming back to a
// window that finished while they were away.
useEffect(
  () =>
    onFocusChange((focused) => {
      const sessionId = selectedSessionIdRef.current;
      if (!focused || !sessionId) return;
      if (statusBySessionRef.current[sessionId] === "completed") {
        markSessionRead(sessionId);
      }
    }),
  [],
);

// A ref rather than a dep, unlike the two above: this handler closes over the
// index and the status map to restore what the session was started with, so a
// listener registered once would go on selecting sessions with the state the
// app had at mount.
const selectSessionRef = useRef(handleSelectSessionIndexItem);
selectSessionRef.current = handleSelectSessionIndexItem;

// The reader clicked a desktop banner. Rust has already raised the window; the
// only thing left is to go to the session it was about.
useEffect(() => {
  const listenerPromise = listen<string>("notification_activated", (event) => {
    void selectSessionRef.current(event.payload);
  });

  return () => {
    listenerPromise.then((unlisten) => unlisten());
  };
}, []);

useEffect(() => {
  const listenerPromise = listen<SessionStatusEvent>("session_status", (event) => {
    const { sessionId, status, modified } = event.payload;

    // Only completion moves this, and the sidebar sorts by it — so a session
    // finishing in the background rises to the top the moment it does, rather
    // than sitting wherever its last send left it until the next refetch.
    // Applied before the read branch below, which returns.
    if (modified) {
      setSessionIndexItems((prev) =>
        prev.map((i) => (i.sessionId === sessionId ? { ...i, modified } : i)),
      );
    }

    // Whatever ended the turn — a result, an interrupt, a dead child — the
    // agent is no longer waiting on anything. The backend's status machine is
    // the one signal that covers every one of those exits, so the wait is
    // cleared from here rather than from each of them.
    if (status !== "in_progress") {
      setWorkingBySession((prev) => ({ ...prev, [sessionId]: null }));
      // A request can only be answered by the child that asked, so one still
      // open when the turn ends is stranded rather than pending — see the
      // stranded-request note in CLAUDE.md. Dropping it here is what stops the
      // sidebar marking a dead session as waiting on the reader forever.
      //
      // Unless the child still holds a background task: the turn ends on its
      // `result` now, and a background subagent can be the one asking.
      if (!tasksBySessionRef.current[sessionId]?.length) {
        setAsksBySession((prev) => (prev[sessionId]?.length ? { ...prev, [sessionId]: [] } : prev));
      }
    }

    // Finishing in front of the reader is read the moment it does; everything
    // else is announced.
    if (status === "completed" && announce(sessionId, "completed", "Task finished")) {
      markSessionRead(sessionId);
      return;
    }

    setStatusBySession((prev) => ({ ...prev, [sessionId]: status }));
  });

  return () => {
    listenerPromise.then((unlisten) => unlisten());
  };
}, []);

// The backend generates a title a few seconds after a session starts and writes
// it to the index itself, so this only mirrors what's already on disk. Its own
// listener rather than a branch in `agent_event`: nothing here came from the
// agent, and it must not land in the session's event list.
// A session created by something other than the composer — an agent calling the
// `dray` CLI, which reaches the backend over its own socket. The row has to
// appear without a refetch, the way a composer-created one does.
//
// The index item alone, never a `SessionSnapshot`: `agent_event` writes into
// sessions this hook already holds and drops events for ids it doesn't, so a
// snapshot here would start a transcript in memory that later events could miss.
// Left as an index item, `handleSelectSessionIndexItem` loads it whole from disk
// on first open — and `session_status` and `session_title` still land, since
// both write by id into maps the sidebar reads rather than into `sessions`.
//
// Deliberately not selected. The user is mid-conversation in the session that
// spawned this one; yanking them out of it is the opposite of what fanning work
// out is for.
useEffect(() => {
  const listenerPromise = listen<SessionIndexItem>("session_created", (event) => {
    const item = event.payload;
    // A new session is never archived, so it belongs to the active list only.
    if (showArchivedRef.current) return;

    setSessionIndexItems((prev) =>
      prev.some((i) => i.sessionId === item.sessionId)
        ? prev.map((i) => (i.sessionId === item.sessionId ? item : i))
        : [...prev, item],
    );
  });

  return () => {
    listenerPromise.then((unlisten) => unlisten());
  };
}, []);

useEffect(() => {
  const listenerPromise = listen<SessionTitleEvent>("session_title", (event) => {
    const { sessionId, title } = event.payload;

    setSessionIndexItems((prev) =>
      prev.map((i) => (i.sessionId === sessionId ? { ...i, title } : i)),
    );
    setSessions((prev) =>
      prev.map((s) => (s.sessionId === sessionId ? { ...s, title } : s)),
    );
  });

  return () => {
    listenerPromise.then((unlisten) => unlisten());
  };
}, []);

// A brand-new session has no id until its first send, so nothing can be in flight.
// The live map wins over the index item: it's the one the backend pushes to.
const selectedStatus: SessionStatus = selectedSessionId
  ? statusBySession[selectedSessionId]
    ?? sessionIndexItems.find((i) => i.sessionId === selectedSessionId)?.status
    ?? "idle"
  : "idle";
const busy = selectedStatus === "in_progress";

// The sessions standing still behind a card the reader has to answer. A set
// rather than the id lists themselves: the sidebar only asks whether a row is
// waiting, and passing the lists would re-render every row on each request.
const askingSessions = useMemo(
  () =>
    new Set(
      Object.entries(asksBySession)
        .filter(([, ids]) => ids.length > 0)
        .map(([sessionId]) => sessionId),
    ),
  [asksBySession],
);

// The dock badge counts the same rows the rail marks, so it lives beside the
// two maps that decide them rather than in `App`.
useDockBadge(statusBySession, asksBySession, sessionIndexItems);

// Prompts typed into the running turn and not yet handed to the CLI. Not gated
// on `busy` like the live state below: a queue only exists while a turn runs,
// and the flush that empties it is the thing that clears these.
const queuedMessages = selectedSessionId ? queuedBySession[selectedSessionId] ?? [] : [];

// Gated on `busy` for the same reason the background-task set is: this is live
// state, and a session that ended while it was unmounted has no event left to
// arrive and clear it.
const working: Working | null = busy && selectedSessionId
  ? workingBySession[selectedSessionId] ?? null
  : null;

// Not gated on `busy`, unlike the two around it: a task outlives the turn that
// spawned it, and that is the whole point of the set having its own indicator.
const backgroundTasks: BackgroundTask[] = useMemo(
  () => (selectedSessionId ? tasksBySession[selectedSessionId] ?? [] : []),
  [tasksBySession, selectedSessionId],
);
// The join the transcript uses to keep a task's spawning call pending after
// the turn ends. Memoised so the transcript memo holds while nothing changed.
const liveTaskIds = useMemo(
  () => new Set(backgroundTasks.map((t) => t.taskId)),
  [backgroundTasks],
);

// Two events with nothing between them, so whichever came last says whether a
// compaction is still running. Gated on `busy` for the same reason as the task
// set above: a `started` with no `completed` after it is the shape a killed
// session leaves in the log forever.
const compacting: boolean = (() => {
  if (!busy || !selectedSession) return false;
  for (let i = selectedSession.events.length - 1; i >= 0; i--) {
    const p = selectedSession.events[i].payload;
    if (p.type === "context_compacted") return false;
    if (p.type === "context_compaction_started") return true;
  }
  return false;
})();

// The retry in flight, if the last thing that happened was one. Derived by
// walking back rather than tracked, for the reason `compacting` is: the event
// is persisted, so the log already answers it.
//
// The rule is "an `api_retry` is the newest thing here", which self-clears
// against every way a retry can end without naming them. The harness gives no
// closing event — a retry that works is just the request going through — so
// anything else arriving is the proof it went through. `usage_update` is
// skipped as the one payload that fires without meaning progress.
//
// Gated on `busy` like the two above: an `api_retry` at the tail of a log is
// exactly what a session killed mid-retry leaves behind forever.
const apiRetry: ApiRetryState | null = (() => {
  if (!busy || !selectedSession) return null;
  for (let i = selectedSession.events.length - 1; i >= 0; i--) {
    const p = selectedSession.events[i].payload;
    if (p.type === "usage_update") continue;
    if (p.type !== "api_retry") return null;
    return {
      attempt: p.attempt,
      maxRetries: p.maxRetries,
      status: p.status,
      reason: p.reason,
    };
  }
  return null;
})();

// How full the model's context is. Derived from the log rather than tracked,
// because both things that move it are already persisted there — a turn's own
// occupancy, and what a compaction left behind.
//
// The two counts are collected independently because they arrive on different
// events: a compaction reports what it kept but not how large the window is,
// and the turn before it does the reverse. Not gated on `busy` like the two
// above — occupancy is a fact about the conversation, not about a live run, so
// a settled session's last reading is still the right one.
const contextUsage: { used: number; max: number } | null = (() => {
  if (!selectedSession) return null;

  let used: number | null = null;
  let usedSettled = false;
  let max: number | null = null;
  const events = selectedSession.events;

  for (let i = events.length - 1; i >= 0 && !(usedSettled && max !== null); i--) {
    const p = events[i].payload;

    if (p.type === "context_compacted") {
      // Settles `used` whether or not it carried a count. Everything before it
      // left the window, so an earlier turn's figure isn't a fallback here —
      // it's the wrong answer, and a high one.
      if (!usedSettled) {
        used = p.postTokens;
        usedSettled = true;
      }
    } else if (p.type === "turn_completed" && p.usage?.contextWindow) {
      const w = p.usage.contextWindow;
      if (!usedSettled) {
        used = w.usedTokens;
        usedSettled = true;
      }
      max ??= w.maxTokens;
    }
  }

  return used !== null && max !== null ? { used, max } : null;
})();

return {harness, setHarness, sessions, selectedSessionId, selectedSession, streamingContentBlock, sessionIndexItems, statusBySession, askingSessions, showArchived, setShowArchived, models, modelId, effort, permissionMode, projects, projectPath, branches, branch, useWorktree, busy, working, backgroundTasks, liveTaskIds, tasksBySession, compacting, apiRetry, contextUsage, error, setError, handleModelChange, setPermissionMode, handleAttachProject, handleSelectProject, handleSelectBranch, pendingBranch, setPendingBranch, runCheckout, setUseWorktree, handleSendMsg, handleInterrupt, handleStopTask, queuedMessages, handleCancelQueued, handleRespondPermission, handleAnswerQuestions, handleSelectSessionIndexItem, handleNewSession, setSessionFlags, forkSession, unlinkIssue, detachSession, deleteSession, removeWorktree};

}