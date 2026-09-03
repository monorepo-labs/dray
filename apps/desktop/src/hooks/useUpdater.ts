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

/// What something the reader asked for is doing.
///
/// The scheduled check has no such state and wants none — it stays silent
/// unless it found something, because nobody asked it. The menu item is a
/// question, so it is answered either way, including when the answer is that
/// nothing happened.
///
/// `install_failed` rides here rather than on a prop of its own, since the
/// footer has one line to say things in either way. It is the one verdict that
/// does not retire itself: the bundle is swapped and the app is still on the
/// old one, so the sentence stays until the reader acts on it.
export type ManualCheck =
  | "idle"
  | "checking"
  | "up_to_date"
  | "failed"
  | "install_failed";

/// Checks for an update on launch and on an interval, and holds what the
/// backend reports back.
///
/// `null` is the resting state and covers every failure: a check that can't
/// reach the manifest emits nothing, so no network is silent rather than an
/// error the reader can do nothing about.
///
/// The channel is held here and handed *out*, rather than read a second time by
/// the settings row that writes it. `useLocalStorage` is per-component, so a
/// second copy would set its own value while this one kept the old — and since
/// `channel` is what re-arms the effect below, the change would take on the
/// next launch and not before. The same trap `useTheme` became a module store
/// to escape; one owner and a prop is enough for two surfaces.
export function useUpdater() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [manual, setManual] = useState<ManualCheck>("idle");
  const [channel, setChannel] = useLocalStorage<UpdateChannel>(
    "ade.updateChannel",
    "stable",
  );

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

  // Read at invoke time rather than closed over: a check's `finally` may fire
  // under a later effect generation, and it needs the channel picked *now* to
  // know whether the one it just asked about has gone stale.
  const channelRef = useRef(channel);
  channelRef.current = channel;

  // The check itself is built inside the effect, so a caller outside reaches it
  // through a ref rather than the effect being pulled apart to expose it.
  const checkRef = useRef<(byHand?: boolean) => void>(() => {});

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
      const used = channelRef.current;
      if (byHand) setManual("checking");
      void invoke("check_update", { channel: used })
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
          // A channel flipped mid-check was swallowed by the guard above —
          // the re-armed effect's own check() found this one still out and
          // returned — so the answer that just settled is for the wrong
          // manifest. Ask again for the one picked now; reading the ref makes
          // this correct even though `check` belongs to an older effect.
          if (!readyRef.current && channelRef.current !== used) check();
        });
    };

    checkRef.current = check;
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

  // The backend launches the new bundle and *then* asks to exit, so a rejection
  // here is a real answer: the swap happened and nothing came up to replace us.
  // Resolving usually means the process is about to die, and the state written
  // on that path is never painted.
  const install = useCallback(() => {
    setManual("idle");
    return invoke("install_update").catch((e) => {
      console.error("[update install]", e);
      setManual("install_failed");
    });
  }, []);

  // Same path the menu item takes, so a check asked for in Settings and one
  // asked for from the menu bar are one thing with one in-flight guard.
  const checkNow = useCallback(() => checkRef.current(true), []);

  // Changing the channel re-arms the effect above, so the new manifest is
  // checked the moment the switch moves — or, when a check is mid-flight, the
  // moment it settles (its `finally` re-asks for the channel picked now). The
  // `ready` guard still holds: a bundle already downloaded is worth keeping
  // whichever channel the reader lands on.
  return { status, manual, install, checkNow, channel, setChannel };
}
