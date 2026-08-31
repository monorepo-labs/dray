import { useEffect, useRef } from "react";

import { pushNotice } from "@/hooks/useNotices";
import { readyToMerge, readyTransitions, sessionBranch } from "@/lib/pr";
import { playNotification } from "@/lib/sound";
import type { PrMark, SessionIndexItem } from "@/types/events";

type Args = {
  /// The rows the sidebar is showing. Marks are only read for these, so this is
  /// also the whole of what can be announced — a session filtered away or
  /// archived is one the reader has already dealt with.
  sessions: SessionIndexItem[];
  /// The sidebar's own per-repo read, keyed the way its rows are.
  prFor: (repoPath: string, branch: string | null) => PrMark | undefined;
};

/// Tells the reader when a pull request becomes ready to merge.
///
/// **The signal is a transition, not a state.** A pull request that is already
/// ready the first time this sees it raises nothing: the app cannot tell a PR
/// that turned green a second ago from one that has been sitting there since
/// last week, and launching onto a sidebar of landed work would open a card for
/// every one of them. So the first reading of a session is recorded in silence
/// and only a *change* out of it is news. The cost is a PR that turned ready
/// while the app was closed, which is found the ordinary way — on the row.
///
/// **It is raised unconditionally**, which no other notice is — see `announce`
/// in [useSessions](./useSessions.ts), where an unfocused window gets a desktop
/// banner instead and a session already on screen gets nothing at all. That
/// split asks "has the reader seen this happen", and for the other three the
/// answer is on screen: a turn's own output is the notification. This one has
/// no such moment. CI reports on someone else's schedule, and the panel's own
/// line changing from "Checks not passing" to "Ready to merge" is a silent
/// swap two words wide that nobody watches for — so being on the PR tab is not
/// the same as having noticed. The one card it can duplicate is one drawn for
/// something the reader is looking at, which costs a glance; missing it costs
/// the merge.
///
/// Its own countdown is what retires it. Nothing marks it read, because nothing
/// here is: the pull request stays ready, and this is a nudge toward it rather
/// than a record of it.
export function usePrReady({ sessions, prFor }: Args) {
  /// What each session's pull request last said, and the whole of the
  /// transition test. An entry appearing for the first time is *seeded*, never
  /// announced, and a reading GitHub has not worked out is *held* rather than
  /// written down. `readyTransitions` owns both rules and the pruning that
  /// comes with them.
  const wasReady = useRef(new Map<string, boolean>());

  useEffect(() => {
    // A session with no mark is left out entirely rather than recorded as
    // not-ready: no mark is not "no pull request", it is also a repo whose read
    // has not landed, and a `false` written there would turn the first real
    // reading into a transition.
    //
    // A mark whose merge state is unknown is the same fact one layer in, so it
    // travels as `null` rather than as a no — see `readyToMerge`. It is what a
    // merge leaves every other open PR in the project reading for a window.
    const observed = sessions.flatMap((session) => {
      const mark = prFor(session.projectPath, sessionBranch(session));
      return mark ? [[session.sessionId, readyToMerge(mark)] as const] : [];
    });

    const { next, became } = readyTransitions(wasReady.current, observed);
    wasReady.current = next;

    for (const sessionId of became) {
      // The sound is the half that carries when the reader's eyes are on the
      // middle of the window, or on another app entirely.
      playNotification();
      pushNotice({
        sessionId,
        kind: "pr",
        // The verb and nothing else, like the completed and asking cards. The
        // session it means is what the button answers: there is one card per
        // session, and pressing it is how the reader finds out which.
        label: "Ready to merge",
      });
    }
  }, [sessions, prFor]);
}
