/// Tweets shown in the right-hand rail, newest first. Entries may be full
/// status URLs or bare ids — `tweetId` takes the last path segment either way,
/// so a link copied straight from X can be pasted here unedited.
export const TWEETS: string[] = [
  "https://x.com/yogesharc/status/2090485873657950535",
  "https://x.com/yogesharc/status/2090095249276436685",
];

/// Strips a status URL down to the numeric id the syndication API keys on.
/// Query strings are common on copied links (`?s=20`), so they go too.
export function tweetId(entry: string): string {
  return entry.split("?")[0].split("/").filter(Boolean).pop() ?? entry;
}
