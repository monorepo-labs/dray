import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { playDictationSound } from "@/lib/sound";
import type { DownloadProgress, TranscribeOutcome, TranscriptionStatus } from "@/types/events";

/// How far each in-flight download has got, keyed by model id.
export type Downloads = Record<string, { received: number; total: number; error?: string }>;

/// Reads and writes everything the transcription tab needs.
///
/// `active` gates the read the same way the changes panel's does: the settings
/// dialog switches bodies rather than hiding them, but the tab is still mounted
/// while another one is on screen, and enumerating audio devices is a real
/// syscall not worth making until somebody is looking.
export function useTranscriptionSettings(active: boolean) {
  const [status, setStatus] = useState<TranscriptionStatus | null>(null);
  const [downloads, setDownloads] = useState<Downloads>({});

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<TranscriptionStatus>("transcription_status"));
    } catch (e) {
      console.error("could not read transcription settings", e);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  // Registered once and never gated on `active`: a download outlives the dialog
  // that started it, and progress arriving while settings are closed still has
  // to be there when they reopen.
  useEffect(() => {
    const unlisten = listen<DownloadProgress>("transcription_download_progress", (e) => {
      const { modelId, received, total, error, cancelled } = e.payload;

      setDownloads((prev) => {
        // A finished, failed or cancelled download stops being an entry rather
        // than becoming a completed one — the row reads its state from
        // `installed`, and a lingering 100% bar would sit over a model that is
        // already downloaded.
        //
        // `cancelled` is carried rather than inferred: a cancel is over without
        // being complete, so its closing event counts as *less* than total and
        // was read here as ordinary progress — putting the row back at 0% and
        // stuck offering Cancel for a task that had already gone.
        if (error || cancelled || received >= total) {
          const { [modelId]: _done, ...rest } = prev;
          return rest;
        }

        return { ...prev, [modelId]: { received, total } };
      });

      if (error) console.error(`downloading ${modelId} failed`, error);
      if (received >= total) void refresh();
    });

    return () => {
      void unlisten.then((f) => f());
    };
  }, [refresh]);

  const download = useCallback(
    async (modelId: string) => {
      // Seeded before the first progress event so the row switches to a bar on
      // the click rather than after the first chunk, which on a slow link is
      // seconds of a button that looks like it did nothing.
      setDownloads((prev) => ({ ...prev, [modelId]: { received: 0, total: 1 } }));

      try {
        await invoke("download_transcription_model", { modelId });
      } catch (e) {
        console.error("download failed", e);
        setDownloads((prev) => {
          const { [modelId]: _failed, ...rest } = prev;
          return rest;
        });
      }

      await refresh();
    },
    [refresh],
  );

  /// Calls off a download in flight.
  ///
  /// The entry is dropped here rather than waiting for the backend's closing
  /// event, so the row goes back to offering Download on the click. The backend
  /// stops between chunks and deletes its partial file, which can be a moment
  /// on a fast link.
  const cancelDownload = useCallback(async (modelId: string) => {
    setDownloads((prev) => {
      const { [modelId]: _stopped, ...rest } = prev;
      return rest;
    });

    await invoke("cancel_transcription_download", { modelId }).catch((e) =>
      console.error("could not cancel download", e),
    );
  }, []);

  const remove = useCallback(
    async (modelId: string) => {
      await invoke("delete_transcription_model", { modelId });
      await refresh();
    },
    [refresh],
  );

  const selectModel = useCallback(
    async (modelId: string | null) => {
      await invoke("select_transcription_model", { modelId });
      await refresh();
    },
    [refresh],
  );

  const selectDevice = useCallback(
    async (device: string | null) => {
      await invoke("select_transcription_device", { device });
      await refresh();
    },
    [refresh],
  );

  const setMute = useCallback(
    async (mute: boolean) => {
      await invoke("set_transcription_mute", { mute });
      await refresh();
    },
    [refresh],
  );

  return {
    status,
    downloads,
    refresh,
    download,
    cancelDownload,
    remove,
    selectModel,
    selectDevice,
    setMute,
  };
}

export type RecorderState = "idle" | "recording" | "transcribing";

/// How often the visualizer asks for a new level.
///
/// ~20fps. The bars are eight blunt rectangles, so a faster poll buys no
/// smoothness and spends an IPC round trip per frame to say so.
const LEVEL_MS = 50;

/// Drives one press of the mic button.
///
/// Every way this can fail to produce words is a *message*, not a silent
/// nothing. The first build returned an empty string for all of them, and a
/// denied microphone — which macOS answers with silence rather than an error —
/// was indistinguishable from a model that did not work.
export function useRecorder<T>({
  target,
  onText,
  onNeedsModel,
  onMessage,
}: {
  /// Where the words should land, read **at the moment recording starts**.
  ///
  /// Pinned rather than read at the end, because a recording outlives the
  /// screen it was started on: the reader can talk, switch sessions, and have
  /// the transcript arrive somewhere else entirely. Handing the live value to
  /// `onText` filed the words under whichever session happened to be selected
  /// when the model finished — words spoken about one task landing in another's
  /// draft, silently.
  target: T;
  onText: (text: string, target: T) => void;
  onNeedsModel: () => void;
  /// Something the reader has to be told. `null` clears it.
  onMessage: (message: string | null) => void;
}) {
  const [state, setState] = useState<RecorderState>("idle");
  /// Loudest sample in the last window, 0–1. Drives the bars.
  const [level, setLevel] = useState(0);
  /// What a run that could not answer left on disk, and the whole of what Retry
  /// needs. Held here rather than sent out through `onMessage`, which takes a
  /// sentence and has nowhere to put a path.
  const [savedAudio, setSavedAudio] = useState<string | null>(null);

  // The callbacks close over the composer's draft, which changes on every
  // keystroke; a ref keeps the returned functions stable so the button does not
  // re-register its handler as the reader types.
  const handlers = useRef({ onText, onNeedsModel, onMessage });
  handlers.current = { onText, onNeedsModel, onMessage };

  // The live value, so `start` can take a copy without depending on it.
  const liveTarget = useRef(target);
  liveTarget.current = target;
  // The copy taken when recording began, which is what `onText` is given.
  const pinnedTarget = useRef(target);

  // Claimed synchronously, because `state` only moves once the IPC it is waiting
  // on resolves — so two ⌘D presses inside that gap both read `idle` and both
  // start. The backend replaces the first recording with the second, and whose
  // response lands last decides which target the surviving stream is filed
  // under. Cancel has the same shape from the other side: it sets `idle` before
  // its own call resolves, so a start pressed in that window can be killed by
  // the cancel it preceded.
  const inFlight = useRef(false);

  // Polled rather than pushed: a level is only interesting *now*, so a missed
  // reading should be a dropped frame and not a queued event arriving late.
  useEffect(() => {
    if (state !== "recording") {
      setLevel(0);
      return;
    }

    let live = true;
    const timer = setInterval(async () => {
      try {
        const next = await invoke<number>("transcription_level");
        if (live) setLevel(next);
      } catch {
        // A level that cannot be read is not worth interrupting a recording for.
      }
    }, LEVEL_MS);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [state]);

  const start = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    handlers.current.onMessage(null);
    // Read *before* the await, not after. `liveTarget` moves with the reader,
    // and the IPC below is a real gap — switching sessions inside it pinned the
    // session arrived at rather than the one spoken from, which is the exact bug
    // pinning exists to stop, just through a smaller window.
    const spokenFrom = liveTarget.current;

    try {
      const refusal = await invoke<{ kind: string } | null>("start_transcription");

      if (refusal?.kind === "needsModel") {
        handlers.current.onNeedsModel();
        return;
      }

      if (refusal?.kind === "needsPermission") {
        handlers.current.onMessage(
          "Dray needs microphone access. Turn it on in System Settings › Privacy & Security › Microphone.",
        );
        return;
      }

      // Committed only once the mic is actually open, so a refusal leaves the
      // previous recording's target alone.
      pinnedTarget.current = spokenFrom;
      // And leaves the kept recording on offer, for the same reason. Talking
      // again is the reader answering that offer — but a press that never
      // opened the microphone is not talking again, and clearing it above the
      // refusals took Retry off screen with the file still on disk, in the one
      // case (`needsModel`) where the retry is the whole point.
      setSavedAudio(null);
      setState("recording");
      // After the refusals, never before: a tone that plays and is then
      // followed by "Dray needs microphone access" has already told the reader
      // the mic is open.
      playDictationSound("start");
    } catch (e) {
      console.error("could not start recording", e);
      handlers.current.onMessage(String(e));
    } finally {
      inFlight.current = false;
    }
  }, []);

  /// The one place an outcome is read, so a retry cannot answer differently
  /// from the stop that preceded it.
  const apply = useCallback((outcome: TranscribeOutcome) => {
    switch (outcome.kind) {
      case "text":
        // The pair closes here rather than where the microphone did, since the
        // wait between the two is what the reader is listening for the end of.
        // Only on words: the outcomes below say their own piece, and this tone
        // would be claiming something landed.
        playDictationSound("stop");
        setSavedAudio(null);
        handlers.current.onText(outcome.value, pinnedTarget.current);
        break;
      case "needsModel":
        // The audio is kept, so downloading a model and pressing Retry gets the
        // words already spoken rather than asking for them a second time.
        setSavedAudio(outcome.value.audioPath);
        handlers.current.onNeedsModel();
        break;
      case "noAudio":
        // The one failure with a cure the reader can act on, and the one that
        // used to be invisible.
        handlers.current.onMessage(
          "No sound was recorded. Check microphone access in System Settings › Privacy & Security › Microphone.",
        );
        break;
      case "empty":
        setSavedAudio(null);
        handlers.current.onMessage("Nothing was said.");
        break;
      case "failed":
        setSavedAudio(outcome.value.audioPath);
        handlers.current.onMessage(
          outcome.value.audioPath
            ? `Transcription failed: ${outcome.value.message}`
            : `Transcription failed, and the recording could not be saved: ${outcome.value.message}`,
        );
        break;
    }
  }, []);

  const stop = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("transcribing");

    try {
      apply(await invoke<TranscribeOutcome>("stop_transcription"));
    } catch (e) {
      console.error("transcription failed", e);
      handlers.current.onMessage(String(e));
    } finally {
      setState("idle");
      inFlight.current = false;
    }
  }, [apply]);

  /// Runs the kept recording through the model again.
  ///
  /// Same states as a stop, since from the reader's side it is the same wait —
  /// the spinner belongs in the same place whether the audio came from the
  /// microphone a moment ago or from disk.
  const retry = useCallback(async () => {
    if (inFlight.current || !savedAudio) return;
    inFlight.current = true;
    setState("transcribing");
    handlers.current.onMessage(null);

    try {
      apply(await invoke<TranscribeOutcome>("retry_transcription", { path: savedAudio }));
    } catch (e) {
      console.error("retrying the transcription failed", e);
      // The file is gone or unreadable, so the offer cannot stand: leaving
      // Retry on screen after this points at nothing.
      setSavedAudio(null);
      handlers.current.onMessage(String(e));
    } finally {
      setState("idle");
      inFlight.current = false;
    }
  }, [apply, savedAudio]);

  /// Throws the recording away. The words are the point of the press, so
  /// cancelling has to be a separate control from stopping — not a second
  /// meaning for the same one.
  const cancel = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("idle");
    handlers.current.onMessage(null);

    try {
      await invoke("cancel_transcription").catch(() => {});
    } finally {
      inFlight.current = false;
    }
  }, []);

  /// What the button and the shortcut both do: start, or finish.
  const toggle = useCallback(() => {
    if (state === "idle") return start();
    if (state === "recording") return stop();

    // Mid-transcription there is nothing to toggle; the model is already running.
    return Promise.resolve();
  }, [state, start, stop]);

  return { state, level, toggle, start, stop, cancel, retry, savedAudio };
}
