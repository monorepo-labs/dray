/// The `#` menu's pull request half: which open PRs a query lists, what a pick
/// writes, and what an empty list says. Rows come off the PR marks cache the
/// pull requests page reads (`usePrMentions`), so this only narrows and words.
import { prRepoSlug } from "@/lib/pr";
import type { PrMark, PrUnavailable } from "@/types/events";

/// As deep as the issue list goes.
const LIMIT = 25;

/// `owner/repo#12`, the identifier an issue tag carries, so a PR goes into the
/// prompt in the same shape and the send resolves it the same way: `gh issue
/// view` answers a PR's number with its title and `/pull/` link.
export function prIdentifier(pr: PrMark): string | null {
  const slug = prRepoSlug(pr.url);
  return slug ? `${slug}#${pr.number}` : null;
}

/// `prs` narrowed to those whose number, title or branch holds `query`, in the
/// order given. A number matches from its start, so `#13` finds 1349.
export function filterPrs(prs: readonly PrMark[], query: string): PrMark[] {
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? prs.filter(
        (pr) =>
          String(pr.number).startsWith(needle) ||
          (pr.listing?.title.toLowerCase().includes(needle) ?? false) ||
          pr.headRefName.toLowerCase().includes(needle),
      )
    : [...prs];
  return matches.slice(0, LIMIT);
}

/// What an empty PR list says, in terms of why it is empty.
export function prEmptyNote(repo: string | null, query: string, error?: PrUnavailable): string {
  if (repo === null) return "No GitHub repository here.";
  if (error?.kind === "no_cli") return "Install the GitHub CLI to list pull requests.";
  if (error?.kind === "not_authenticated") return "Run `gh auth login` to list pull requests.";
  if (error) return "Couldn't read pull requests.";
  if (query.trim()) return "No pull request matches that.";
  return "No open pull requests in this repository.";
}
