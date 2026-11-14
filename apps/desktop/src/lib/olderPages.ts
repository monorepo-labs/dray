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

let dropper: (sessionId: string, keepFrom?: string) => void = () => {};

export function setOlderDropper(drop: (sessionId: string, keepFrom?: string) => void) {
  dropper = drop;
}

/// Lets go of the pages read above event `keepFrom`, as far as one began, or
/// above the tail it opened on with none named, so a transcript read back and
/// left holds its tail again. Read again on scroll.
export function dropOlder(sessionId: string, keepFrom?: string) {
  dropper(sessionId, keepFrom);
}
