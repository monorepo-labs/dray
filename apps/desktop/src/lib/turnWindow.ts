/// How many of the newest turns a transcript's first read holds. The
/// transcript opens pinned to the bottom, so these are the turns on screen;
/// everything older is read a page at a time as the reader scrolls up.
///
/// Why not all of them: each collapsed turn renders its answer through
/// Streamdown, and that parse is the whole cost of opening a long session —
/// measured at 150–260ms for 53 answers before the DOM was even committed,
/// against under 100ms for reading, transferring and parsing the 11MB log they
/// came from. Eight covers a full pane at any height this app runs at.
export const FIRST_MOUNT = 8;
