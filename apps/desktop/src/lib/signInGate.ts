/// Whether the sign-in gate stands in front of the app (#1330). Release
/// builds always gate. Dev builds skip it, since every dev app a task starts
/// otherwise stops at sign-in first. A saved account is still used, so only a
/// dev home without one runs as a signed-out app does. `VITE_DRAY_SIGN_IN=1`
/// brings the gate back for work on the gate itself.
export function gatesSignIn(env: { DEV: boolean; VITE_DRAY_SIGN_IN?: string }): boolean {
  return !env.DEV || env.VITE_DRAY_SIGN_IN === "1";
}
