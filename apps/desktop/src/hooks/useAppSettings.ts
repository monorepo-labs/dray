import { useCallback, useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import type { SettingsView } from "@/types/events";

/// The preferences the backend owns, as opposed to the ones kept in local
/// storage — see `settings.rs` for why analytics can only live on that side.
///
/// Answers with the *effective* state rather than what is on disk, so a run the
/// environment has forced off draws a switch that says so.
///
/// Read when the dialog first opens rather than at startup: nothing else draws
/// these, and the one setting here is already applied by the time the window
/// exists.
export function useAppSettings(active: boolean) {
  const [settings, setSettings] = useState<SettingsView | null>(null);

  useEffect(() => {
    if (!active || settings) return;

    let live = true;
    invoke<SettingsView>("get_settings")
      .then((next) => {
        if (live) setSettings(next);
      })
      // Not worth a row of its own: the switch stays disabled on its resting
      // state, which is the one place this can fail visibly.
      .catch((e) => console.error("[settings read]", e));

    return () => {
      live = false;
    };
  }, [active, settings]);

  /// Written through rather than optimistically: the backend answers with the
  /// state as it now stands, and that answer is what the switch draws. A failed
  /// write therefore leaves the switch where it was, which is the truth.
  const setAnalyticsEnabled = useCallback(async (enabled: boolean) => {
    try {
      setSettings(await invoke<SettingsView>("set_analytics_enabled", { enabled }));
    } catch (e) {
      console.error("[settings write]", e);
    }
  }, []);

  return { settings, setAnalyticsEnabled };
}
