import { invoke } from "@/lib/transport";

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

/// Reports a render error by **where** it broke, never by what it said.
///
/// Two closed things leave: React's error code, read off the minified message
/// (`#185` is an update loop), and the component stack's frames reduced to
/// `name@bundle:line:col` — our own minified bundle, which a source map of that
/// release names. A frame pointing anywhere else is dropped, so no path, prompt
/// or message text can ride along. Swallows failures like [`trackFeature`].
export function trackRenderError(error: Error, componentStack: string) {
  const code = /Minified React error #(\d+)/.exec(error.message)?.[1];
  const frames = componentStack
    .split("\n")
    .map((line) => /^\s*at (\S+) \(tauri:\/\/localhost\/assets\/([\w.-]+\.js):(\d+):(\d+)\)$/.exec(line))
    .filter((m) => m !== null)
    .slice(0, 8)
    .map(([, name, file, line, col]) => `${name}@${file}:${line}:${col}`);
  void invoke("track_render_error", { code: code ? Number(code) : null, frames }).catch(() => {});
}

/// Reports that the app is being used today.
///
/// Fired on every focus gain and throttled in Rust to one report per local day,
/// against the same key the backend's own two call sites claim — so this
/// decides nothing about whether anything is sent, and there is no state here
/// to keep in step with theirs.
///
/// Swallows failures for the same reason [`trackFeature`] does.
export function trackActiveDay() {
  void invoke("track_active_day").catch(() => {});
}
