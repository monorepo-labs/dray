import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useState, useEffect, useMemo, useRef } from "react";
import { useComposerPrefs, type EffortByModel } from "@/hooks/useComposerPrefs";
import { dismissNotice, pushNotice, type NoticeKind } from "@/hooks/useNotices";
import { isWindowFocused, onFocusChange } from "@/lib/focus";
import { notifyOS } from "@/lib/notify";
import { playNotification } from "@/lib/sound";
import { AgentEvent, ApprovalPolicy, BackgroundTask, BranchList, Effort, Model, ModelId, Project, QueuedMessage, SendOutcome, SessionIndexItem, SessionSnapshot, SessionStatus, SessionStatusEvent, SessionTitleEvent } from "../types/events";

// Only for a session indexed before the model was recorded, which reads back as
// "unknown". Everything else seeds from the user's stored prefs.
const DEFAULT_MODEL: ModelId = "haiku";
const DEFAULT_EFFORT: Effort = "high";

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
    const [modelId, setModelId] = useState<ModelId>(() => prefs.modelId);
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
    // sessionId → prompts typed during a running turn, oldest first, still
    // waiting for the backend to hand them to the CLI. Mirrors the queue in
    // `Session`, which is the authority; this copy exists so the composer can
    // draw them. Nothing is persisted on either side, so both die with the
    // process and neither can come back stale.
    const [queuedBySession, setQueuedBySession] = useState<Record<string, QueuedMessage[]>>({});
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
  if (nextEffort) {
    const next = { ...effortByModel, [nextModelId]: nextEffort };
    setEffortByModel(next);
    setPrefs({ modelId: nextModelId, effortByModel: next });
    return;
  }
  setPrefs({ modelId: nextModelId });
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
  attachmentPaths: string[] = [],
) => {

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
      harness: "claude_code",
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
    if (outcome.queued) {
      const queued = outcome.queued;
      setQueuedBySession((prev) => ({
        ...prev,
        [sessionId]: [...(prev[sessionId] ?? []), queued],
      }));
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
    if (!cancelled) return null;
    setQueuedBySession((prev) => ({
      ...prev,
      [sessionId]: (prev[sessionId] ?? []).filter((m) => m.id !== cancelled.id),
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
  setSelectedSessionId(null);
  setModelId(prefs.modelId);
  setEffortByModel(prefs.effortByModel);
  setPermissionModeState(prefs.permissionMode);
  setUseWorktreeState(prefs.useWorktree);
  setBranch(branches?.current ?? null);
};

const handleSelectSessionIndexItem = async (sessionId: string) => {
  setSelectedSessionId(sessionId);

  // Opening the session is answering the notice about it, whatever it said —
  // an unread completion is read, and a pending request is now on screen.
  dismissNotice(sessionId);

  // Opening a finished session is reading it.
  const clicked = sessionIndexItems.find((i) => i.sessionId === sessionId);
  if ((statusBySession[sessionId] ?? clicked?.status) === "completed") {
    markSessionRead(sessionId);
  }

  // Restores what this session was started with. Every setter here is the raw
  // state setter, never the prefs-writing wrapper: these values are the session's,
  // not the user's choice, and clicking through the sidebar must not rewrite the
  // defaults that `handleNewSession` reads back.
  const indexItem = sessionIndexItems.find((i) => i.sessionId === sessionId);
  if (indexItem) {
    // Sessions indexed before the model was recorded read back as "unknown".
    const restored =
      indexItem.model === "unknown" ? DEFAULT_MODEL : indexItem.model;
    setModelId(restored);
    // The index stores one model/effort pair, so it can only seed that model's
    // entry; the rest of the map falls back to per-model defaults.
    if (indexItem.effort) {
      setEffortByModel((prev) => ({ ...prev, [restored]: indexItem.effort! }));
    }
    setPermissionModeState(indexItem.permissionMode);
  }

  // Project, branch, and the worktree flag aren't restored — the composer hides
  // all three once a session exists, and they'd only mislead the next new chat.

  if (sessions.some((s) => s.sessionId === sessionId)) {
    return;
  }

  try {
    const snapshot = await invoke<SessionSnapshot | null>("get_session_by_id", { sessionId });
    if (snapshot) {
      upsertSession(snapshot);
    }
  } catch (e) {
    setError(String(e));
  }
}



// One call for both flags, so a click writes only the one it owns. The row is
// replaced from what the store returned rather than from the value we sent —
// the index is authoritative, and a failed write must not leave the sidebar
// showing a state the disk doesn't have.
const setSessionFlags = async (
  sessionId: string,
  flags: { archived?: boolean; pinned?: boolean },
) => {
  try {
    const updated = await invoke<SessionIndexItem | null>("set_session_flags", {
      sessionId,
      archived: flags.archived ?? null,
      pinned: flags.pinned ?? null,
    });
    if (!updated) return;
    setSessionIndexItems((prev) =>
      prev.flatMap((i) => {
        if (i.sessionId !== sessionId) return [i];
        // Archiving from the active list — or unarchiving from the archived one —
        // moves the row to the other view, so it leaves this one rather than
        // sitting there contradicting the filter that produced the list.
        return updated.archived === showArchived ? [updated] : [];
      }),
    );
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
  } catch (e) {
    setError(String(e));
  }
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
  invoke<Model[]>("list_models").then(setModels);
}, [])

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
              dismissNotice(agentEvent.sessionId);
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

// `completed` means finished *and unread*. Reading is what retires it, so every
// path to a read funnels through here: the status landing on the session already
// on screen, the user clicking a finished one in the sidebar, and coming back to
// a window that finished its turn while it was in the background.
const markSessionRead = (sessionId: string) => {
  setStatusBySession((prev) => ({ ...prev, [sessionId]: "idle" }));
  // The notice and the unread dot report the same thing, so the read that
  // retires one retires the other.
  dismissNotice(sessionId);
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
      setAsksBySession((prev) => (prev[sessionId]?.length ? { ...prev, [sessionId]: [] } : prev));
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

// The set is republished whole on every change, so the last one in the log *is*
// the current set — but only while the session is live. A stale non-empty set
// survives in the log across a restart, which is why this gates on `busy`.
const backgroundTasks: BackgroundTask[] = (() => {
  if (!busy || !selectedSession) return [];
  for (let i = selectedSession.events.length - 1; i >= 0; i--) {
    const p = selectedSession.events[i].payload;
    if (p.type === "background_tasks_changed") return p.tasks;
  }
  return [];
})();

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

return {sessions, selectedSessionId, selectedSession, streamingContentBlock, sessionIndexItems, statusBySession, askingSessions, showArchived, setShowArchived, models, modelId, effort, permissionMode, projects, projectPath, branches, branch, useWorktree, busy, working, backgroundTasks, compacting, contextUsage, error, setError, handleModelChange, setPermissionMode, handleAttachProject, handleSelectProject, handleSelectBranch, pendingBranch, setPendingBranch, runCheckout, setUseWorktree, handleSendMsg, handleInterrupt, handleStopTask, queuedMessages, handleCancelQueued, handleRespondPermission, handleAnswerQuestions, handleSelectSessionIndexItem, handleNewSession, setSessionFlags, deleteSession};

}