/// The key a body cut from a first frame carries: in a call's `input`, and in
/// its result's `structured`. Stated again from thin.rs's `CUT`.
const CUT = "_cut";

/// Whether a tool call's `input`, or its result's `structured`, was cut down
/// by the server (`get_session_by_id`'s `lite`, and the pages above it). A
/// row drawing one shows no figure computed from it, and asks for the call
/// when it needs the body (`completeCall`).
export function isCut(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as Record<string, unknown>)[CUT] === true;
}
