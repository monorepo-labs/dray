/// What a bare Escape does once nothing else on the page has answered it.
///
/// Called from `main.tsx`'s window listener, which runs after every handler on
/// the document, so a dialog, menu, search field or the composer always has
/// first claim on the key. One slot, not a list: a second fallback would need
/// an order between the two, and nothing yet wants one.
let fallback: (() => boolean) | null = null;

/// Sets the fallback; the returned function clears it, for an effect's cleanup.
export function onUnhandledEscape(fn: () => boolean): () => void {
  fallback = fn;
  return () => {
    if (fallback === fn) fallback = null;
  };
}

/// Runs the fallback for an Escape nobody handled. Returns whether it acted.
export function runUnhandledEscape(e: KeyboardEvent): boolean {
  if (e.key !== "Escape" || e.defaultPrevented) return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return fallback?.() ?? false;
}
