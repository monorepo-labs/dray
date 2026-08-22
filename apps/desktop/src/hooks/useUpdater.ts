import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useLocalStorage } from "@/hooks/useLocalStorage";
import type { UpdateChannel, UpdateStatus } from "@/types/events";

// Long enough that a session left open for a week still finds an update, short
// enough that it isn't only ever the launch check doing the work.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Long enough to read, short enough that an answer to a question already asked
// doesn't settle in as a second permanent row.
const VERDICT_MS = 4000;

/// What a hand-triggered check is doing.
///
/// The scheduled check has no such state and wants none — it stays silent
/// unless it found something, because nobody asked it. The menu item is a
/// question, so it is answered either way, including when the answer is that
/// nothing happened.
export type ManualCheck = "idle" | "checking" | "up_to_date" | "failed";

/// Checks for an update on launch and on an interval, and holds what the
/// backend reports back.
///
/// `null` is the resting state and covers every failure: a check that can't
/// reach the manifest emits nothing, so no network is silent rather than an
/// error the reader can do nothing about. The channel has no UI yet — it is
/// read from storage so opting into beta is a one-line change when it does.
export function useUpdater() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [manual, setManual] = useState<ManualCheck>("idle");
  const [channel] = useLocalStorage<UpdateChannel>("ade.updateChannel", "stable");

  // Read inside the check's own promise, which resolves long after the closure
  // that started it was made — on a run that finds something, only once the
  // whole bundle has downloaded.
  const statusRef = useRef(status);
  statusRef.current = status;

  // A downloaded bundle is the end of the road until the app restarts, so the
  // interval stops rather than re-downloading the same version every 6 hours.
  const ready = status?.state === "ready";
  const readyRef = useRef(ready);
  readyRef.current = ready;

  // A check runs the download too, so a second one overlapping the first would
  // fetch the same bundle twice. StrictMode's double effect makes that the
  // normal case in dev rather than a race worth waving at.
  const inFlight = useRef(false);

  useEffect(() => {
    const unlisten = listen<UpdateStatus>("update_status", (event) => {
      setStatus(event.payload);
    });

    // A bundle already downloaded, or a check still running, is its own answer
    // — so the guard returns before `manual` is touched, rather than leaving it
    // stuck on "checking" for a run that never started.
    const check = (byHand = false) => {
      if (readyRef.current || inFlight.current) return;
      inFlight.current = true;
      if (byHand) setManual("checking");
      void invoke("check_update", { channel })
        .then(() => {
          if (!byHand) return;
          // The command emits nothing and still resolves when there is nothing
          // newer, so a status that never arrived is the whole of the signal.
          setManual(statusRef.current ? "idle" : "up_to_date");
        })
        .catch((e) => {
          console.warn("[update check]", e);
          // Silence is right for the scheduled check — being offline is not
          // something the reader can act on — but this one was asked for, and
          // an unanswered question reads as a broken menu item.
          if (byHand) setManual("failed");
        })
        .finally(() => {
          inFlight.current = false;
        });
    };

    check();
    const timer = setInterval(() => check(), CHECK_INTERVAL_MS);
    const unlistenMenu = listen("check_update_requested", () => check(true));

    return () => {
      void unlisten.then((f) => f());
      void unlistenMenu.then((f) => f());
      clearInterval(timer);
    };
  }, [channel]);

  // Both verdicts retire themselves. Neither is a state the app should still be
  // in when the reader next looks at the sidebar.
  useEffect(() => {
    if (manual !== "up_to_date" && manual !== "failed") return;
    const timer = setTimeout(() => setManual("idle"), VERDICT_MS);
    return () => clearTimeout(timer);
  }, [manual]);

  // Resolving at all means the install failed — the backend relaunches the app
  // on success, so nothing downstream of this ever runs.
  const install = useCallback(
    () =>
      invoke("install_update").catch((e) => {
        console.error("[update install]", e);
      }),
    [],
  );

  return { status, manual, install };
}
