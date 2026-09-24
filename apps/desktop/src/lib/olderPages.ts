/// How a transcript asks for the turns above its loaded tail. A module slot,
/// like `setIssueOpener`, because the transcript is drawn in three places and
/// the log lives in `useSessions`.
let loader: (sessionId: string) => void = () => {};

export function setOlderLoader(load: (sessionId: string) => void) {
  loader = load;
}

export function loadOlder(sessionId: string) {
  loader(sessionId);
}
