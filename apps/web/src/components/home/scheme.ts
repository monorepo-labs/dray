// Not in SchemeToggle's module: anything a server component imports from a
// "use client" file arrives as a client reference, not the string.
export const SCHEME_KEY = "dray-scheme";

/// Runs in the head before the body is parsed, so the page paints in the
/// right scheme: the reader's saved pick, else the system's, which it keeps
/// following until they pick one. Set on <html> for every page, read by the
/// homepage alone.
export const SCHEME_SCRIPT = `(() => {
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: light)");
  const saved = () => { try { return localStorage.getItem("${SCHEME_KEY}"); } catch { return null; } };
  root.dataset.scheme = saved() || (media.matches ? "light" : "dark");
  media.addEventListener("change", (e) => { if (!saved()) root.dataset.scheme = e.matches ? "light" : "dark"; });
})()`;
