/// Which tracker the issue surfaces are reading, and which repository under
/// GitHub.
///
/// **One pick for the whole app, never a merged list.** Both trackers can be
/// connected at once, and folding their issues into one page would put two
/// unrelated workspaces under one set of headings — with no ordering that means
/// anything across them, since a Linear issue carries a priority and a GitHub
/// one does not. So the reader picks, on chips in the issues page's filter row
/// or on the header of the composer's `#` menu, and flipping either moves both.
///
/// A module store rather than `useLocalStorage`, for the reason [useTheme]
/// gives: several surfaces read this at once, and a per-hook copy would let the
/// page's chips and the composer's header disagree about which tracker is up.
///
/// [useTheme]: ../hooks/useTheme.ts
import { channel } from "@/lib/channel";
import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import type { IntegrationsView, IssueTracker } from "@/types/events";

const TRACKER_KEY = "ade.issueTracker";

/// Which repository the issues page is reading under GitHub. Its own key, since
/// it survives a trip through Linear and back — the alternative is the page
/// forgetting where it was every time the chip is flipped.
const REPO_KEY = "ade.issueRepo";

const TRACKERS: IssueTracker[] = ["linear", "github"];

const bumped = channel<void>();

/// Which trackers have something behind them. The shape [useIntegrations]
/// answers with, narrowed to the one question this file asks.
///
/// [useIntegrations]: ../hooks/useIntegrations.ts
export type Connected = { linear: boolean; github: boolean };

export function connectedTrackers(integrations: IntegrationsView | null): Connected {
  return { linear: !!integrations?.linear, github: !!integrations?.github };
}

/// The stored pick, or Linear where nothing has been stored.
///
/// An unrecognised value reads as Linear rather than being kept: this is local
/// storage, so it can hold whatever a previous build wrote there.
export function readIssueTracker(): IssueTracker {
  const stored = readLocalStorage<IssueTracker>(TRACKER_KEY, "linear");

  return TRACKERS.includes(stored) ? stored : "linear";
}

export function setIssueTracker(tracker: IssueTracker): void {
  writeLocalStorage(TRACKER_KEY, tracker);
  bumped.emit();
}

/// The repository the GitHub half is reading, or `null` for one nobody has
/// picked. `null` is an ordinary state and the page's own empty state: the list
/// of repositories is what the reader attached projects for, and reading every
/// one of them is a `gh` spawn per repo for a list nobody asked for.
export function readIssueRepo(): string | null {
  return readLocalStorage<string | null>(REPO_KEY, null) || null;
}

export function setIssueRepo(repo: string | null): void {
  writeLocalStorage(REPO_KEY, repo);
  bumped.emit();
}

export const subscribeIssueTracker = bumped.subscribe;

/// Which tracker is actually being read, given what is connected.
///
/// The pick is honoured only where there is something behind it: with one
/// tracker connected the effective one is whichever that is, whatever was
/// picked last — a reader who disconnects Linear should not land on an empty
/// page with a chip row that has nothing to flip to. With neither connected the
/// pick stands, since the page then draws its empty state and the pick is what
/// decides which half of it is offered.
export function effectiveTracker(pick: IssueTracker, connected: Connected): IssueTracker {
  if (connected[pick]) return pick;
  if (connected.linear) return "linear";
  if (connected.github) return "github";

  return pick;
}

/// Whether the chips are worth drawing. One tracker is not a choice, and a
/// control that can only say what it already says is chrome.
export function canSwitchTracker(connected: Connected): boolean {
  return connected.linear && connected.github;
}
