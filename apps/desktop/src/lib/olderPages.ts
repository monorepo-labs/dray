/// How a transcript asks for the turns above its loaded tail. A module slot,
/// like `setIssueOpener`, because the transcript is drawn in three places and
/// the log lives in `useSessions`.
let loader: (sessionId: string, turns?: number) => void = () => {};

export function setOlderLoader(load: (sessionId: string, turns?: number) => void) {
  loader = load;
}

/// `turns` widens the page, for a reader hunting further back than a scroll.
export function loadOlder(sessionId: string, turns?: number) {
  loader(sessionId, turns);
}
