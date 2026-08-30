import type { ApprovalPolicy, Harness } from "@/types/events";

/// The stances a harness can actually honour, for one that cannot honour them
/// all. Absent means every stance in the picker applies.
///
/// Codex has no plan mode: its own three are ask / approve-for-me / full
/// access, and `plan` maps onto read-only-and-ask — close, but a stance Codex
/// never names, so offering it would promise a mode it does not have.
///
/// pi has **no permission system**. Not a different one: it runs what the model
/// asks for, and the gate belongs to an extension the reader installs. Two of
/// the four are still real there and for opposite reasons. `plan` is a *flag* —
/// `--tools read,grep,find,ls` at spawn — so pi enforces it and nothing can
/// talk past it. `bypassPermissions` is what pi does with no extension loaded,
/// which is the truthful name for its default. `manual` and `auto` are the two
/// with nothing behind them, so they are not offered.
const HONOURED: Partial<Record<Harness, ApprovalPolicy[]>> = {
  codex: ["bypassPermissions", "manual", "auto"],
  pi: ["plan", "bypassPermissions"],
};

/// Whether this harness honours this stance.
export function honoursMode(harness: Harness, mode: ApprovalPolicy): boolean {
  const honoured = HONOURED[harness];
  return !honoured || honoured.includes(mode);
}

/// The stance to record for a session, given the one the composer holds.
///
/// A session can arrive on a stance its harness does not honour — a spawned one
/// takes its parent's, and a parent on another harness had four to choose
/// from — so this is not merely the picker's own filter restated. Written into
/// the index, so it has to be what is *actually happening*: recording `auto`
/// for a pi session running ungated is a lie a later build could read back and
/// believe.
///
/// Falls to the harness's most permissive stance rather than its most
/// restrictive, because that is the one describing what the CLI will do. A
/// session recorded `plan` that is not passed `--tools` would be the same lie
/// pointed the other way, and the more alarming direction to be wrong in.
export function stanceFor(harness: Harness, mode: ApprovalPolicy): ApprovalPolicy {
  return honoursMode(harness, mode) ? mode : "bypassPermissions";
}
