/// Whether the sign-in gate stands in front of the app (#1330). Release
/// builds always gate. Dev builds skip it, since every dev app a task starts
/// otherwise stops at sign-in first. A saved account is still used, so only a
/// dev home without one runs as a signed-out app does. `VITE_DRAY_SIGN_IN=1`
/// brings the gate back for work on the gate itself.
/// Set once a reader has been through onboarding to the sign-in page, or signed
/// in at all, so onboarding plays once: a quit before signing in reopens on the
/// gate, and a reader who later signs out is never shown it again.
export const ONBOARDED = "dray.onboarded";

export function gatesSignIn(env: { DEV: boolean; VITE_DRAY_SIGN_IN?: string }): boolean {
  return !env.DEV || env.VITE_DRAY_SIGN_IN === "1";
}
