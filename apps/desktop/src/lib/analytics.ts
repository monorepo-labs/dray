import { invoke } from "@tauri-apps/api/core";

/// Reports a feature the frontend owns, for the handful whose only chokepoint
/// is a click handler — the backend reports its own.
///
/// Consent, the install id and the opt-out all live in Rust and are read there
/// on every send, so this carries no state and answers no question: a call from
/// here is a request to report, not a decision that it will be.
///
/// **Never throws and never reports.** A failed `invoke` is swallowed whole,
/// since the one thing worse than a missing event is a feature failing because
/// counting it did.
export function trackFeature(feature: string) {
  void invoke("track_feature", { feature }).catch(() => {});
}
