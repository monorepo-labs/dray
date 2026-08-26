import { useCallback, useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import type { AppSettings } from "@/types/events";

/// The preferences the backend owns, as opposed to the ones kept in local
/// storage — see `settings.rs` for why analytics can only live on that side.
///
/// Read once when the dialog first opens rather than at startup: nothing else
/// draws these, and the one setting here is already applied by the time the
/// window exists.
export function useAppSettings(active: boolean) {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    if (!active || settings) return;

    let live = true;
    invoke<AppSettings>("get_settings")
      .then((next) => {
        if (live) setSettings(next);
      })
      // A settings file that cannot be read is not worth a row of its own: the
      // backend already falls back to the defaults, and the switch stays on
      // the resting state until it answers.
      .catch((e) => console.error("[settings read]", e));

    return () => {
      live = false;
    };
  }, [active, settings]);

  /// Written through rather than optimistically: the backend answers with the
  /// settings as they now stand, and that answer is what the switch draws. A
  /// failed write therefore leaves the switch where it was, which is the truth.
  const setAnalyticsEnabled = useCallback(async (enabled: boolean) => {
    try {
      setSettings(await invoke<AppSettings>("set_analytics_enabled", { enabled }));
    } catch (e) {
      console.error("[settings write]", e);
    }
  }, []);

  return { settings, setAnalyticsEnabled };
}
