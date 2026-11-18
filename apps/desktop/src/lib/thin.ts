/// The key a body cut from a first frame carries: in a call's `input`, and in
/// its result's `structured`. Stated again from thin.rs's `CUT`.
const CUT = "_cut";

/// Whether a tool call's `input`, or its result's `structured`, was cut down
/// by the server for a first frame (`SessionSnapshot.lite`). A row drawing one
/// shows no figure computed from it and asks for the whole transcript.
export function isCut(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as Record<string, unknown>)[CUT] === true;
}
