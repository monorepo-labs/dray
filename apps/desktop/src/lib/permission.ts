import type { ApprovalPolicy, Harness } from "@/types/events";

/// The stances a harness can actually honour, for one that cannot honour them
/// all. Absent means every stance in the picker applies.
///
/// Codex has no plan mode: its own three are ask / approve-for-me / full
/// access, and `plan` maps onto read-only-and-ask — close, but a stance Codex
/// never names, so offering it would promise a mode it does not have.
///
/// pi honours **none of them**, so it draws no picker at all. It has no
/// permission system of its own — it runs what the model asks for, and the gate
/// belongs to an extension the reader installs and configures themselves. Both
/// popular ones are configured by a `config.json` on disk, at global and
/// project scope, with no flag, env var or runtime setter to hand them a stance
/// through; so a picker here could only ever have set something they do not
/// read. Once one is installed its own asks arrive on the ask channel and are
/// drawn like any other, which is the whole of the reader-facing surface.
///
/// `plan` was offered and withdrawn. It was the one stance pi could enforce —
/// `--tools read,grep,find,ls` at spawn, fixed for the process and covering
/// extension tools too — but a lone read-only switch is not a permission mode,
/// and beside it `bypassPermissions` named a bypass Dray does not perform. The
/// enforcement stays in `pi.rs`, so a session already recorded `plan` still
/// runs read-only rather than quietly running ungated.
const HONOURED: Partial<Record<Harness, ApprovalPolicy[]>> = {
  codex: ["bypassPermissions", "manual", "auto"],
  pi: [],
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
