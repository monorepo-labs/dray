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

let completer: (sessionId?: string) => void = () => {};

export function setCompleter(complete: (sessionId?: string) => void) {
  completer = complete;
}

/// Asks for the whole of a transcript held as a first frame
/// (`SessionSnapshot.lite`): every transcript on screen with no id named, for
/// a row that knows its body was cut but not whose it is. Nothing to do for
/// one already whole.
export function completeTranscript(sessionId?: string) {
  completer(sessionId);
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
