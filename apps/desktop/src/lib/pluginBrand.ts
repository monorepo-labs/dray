import { parseSlashCommand } from "@/lib/slash";

/// Brand colours for the plugins whose commands are worth naming on sight.
///
/// Greptile reviews this project's pull requests for free, so a prompt running
/// one of their commands says whose it is. The app draws every other vendor mark
/// on `currentColor` — see [AgentIcon] — and this is the deliberate exception,
/// not the start of a colouring scheme: a plugin earns an entry by that kind of
/// relationship, and there is one today.
///
/// Keyed by a command's namespace where it has one (`greptile:review`) and by
/// its whole name where it doesn't. Both shapes are needed for one vendor:
/// Greptile ship `/greptile:review` and `/greptile:login` through their plugin,
/// but `/greploop`, `/cli-review` and `/check-pr` are skills symlinked into
/// `~/.claude/skills`, which arrive bare. Their `SKILL.md` names the author and
/// that never reaches the wire, so the name is all there is to go on.
///
/// A bare name is a weaker claim than a namespace — some other `/check-pr` would
/// take the colour — and it costs a wrongly tinted bubble and nothing else, so
/// it is not worth a scheme the wire can't support. The transcript outlives the
/// session, which is why the installed command list is no help either.
///
/// [AgentIcon]: ../components/AgentIcon.tsx
const GREPTILE = "#28e99f"; // Greptile Green, from greptile.com/design.

const PLUGIN_BRAND: Record<string, string> = {
  greptile: GREPTILE,
  greploop: GREPTILE,
  "cli-review": GREPTILE,
  "check-pr": GREPTILE,
};

/// The brand colour a sent prompt's bubble carries, or `null` for every
/// ordinary message.
///
/// The colour itself, not a finished background: it rides onto the bubble as
/// `--brand` and App.css decides what to do with it. Every theme fills the
/// bubble with it and inks it with a near-black mixed from it, the palette
/// having no say in either — a wash over the bubble's own card was the first
/// answer and landed as a different colour in every palette, none of them the
/// brand.
export function commandBrand(text: string): string | null {
  const command = parseSlashCommand(text);
  if (!command) return null;

  const name = command.name.toLowerCase();
  const colon = name.indexOf(":");
  const key = colon === -1 ? name : name.slice(0, colon);

  // `hasOwn` rather than a plain lookup: `/valueOf` would otherwise find
  // `Object.prototype`'s and hand a function back as a colour, which reaches
  // the CSS as an invalid `--brand` and leaves the default light bubble with no
  // background at all.
  return Object.hasOwn(PLUGIN_BRAND, key) ? PLUGIN_BRAND[key] : null;
}
