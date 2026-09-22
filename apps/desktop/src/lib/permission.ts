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
///
/// fx exposes two modes over ACP — `ask` and `code` — and no bypass:
/// `full-access` is neither a session mode nor reachable by env or flag on
/// `fx acp`. So `auto` is the widest stance fx can run, and it is what an
/// unhonoured one falls to there.
const HONOURED: Partial<Record<Harness, ApprovalPolicy[]>> = {
  codex: ["bypassPermissions", "manual", "auto"],
  pi: [],
  fx: ["manual", "auto"],
  // Three, and `plan` is the one missing: grok has a plan *mode* of its own
  // that it enters by asking (`_x.ai/exit_plan_mode` raises the card), which is
  // the model's decision rather than a stance the composer can set it to.
  grok: ["manual", "auto", "bypassPermissions"],
};

/// The stance a harness actually runs when handed one it does not honour.
///
/// fx: a bypass falls to `auto`, the widest it can run. `plan` is narrower
/// than anything fx has and falls the other way, to `manual` — fx.rs runs
/// that as `ask`, and a spawned session inheriting `plan` must never come out
/// freer than its parent.
const FALLBACK: Partial<Record<Harness, (mode: ApprovalPolicy) => ApprovalPolicy>> = {
  fx: (mode) => (mode === "plan" ? "manual" : "auto"),
  // `plan` is the only stance grok does not honour, and it must fall to the
  // *narrowest* thing grok has rather than to the default below it: a spawned
  // session inherits its parent's stance, so a `plan` parent landing on
  // `bypassPermissions` would come out ungated by inheriting a narrower one.
  grok: (mode) => (mode === "plan" ? "manual" : "bypassPermissions"),
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
  if (honoursMode(harness, mode)) return mode;
  return FALLBACK[harness]?.(mode) ?? "bypassPermissions";
}
