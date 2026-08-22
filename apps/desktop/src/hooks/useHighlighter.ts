import { useEffect, useState } from "react";
import { getHighlighterIfLoaded, preloadHighlighter } from "@pierre/diffs";

import type { CodeThemePair } from "@/lib/codeTheme";

/// Whether the shared highlighter can tokenize `lang` in `pair` *right now*.
///
/// Not `isHighlighterLoaded()`: that only reports whether the instance exists,
/// and themes and grammars attach to it independently and lazily. A view that
/// trusts it mounts as soon as any other view has warmed the highlighter, then
/// renders unhighlighted — which is why a row could need collapsing and
/// re-expanding to come out right.
function canTokenize(lang: string, pair: CodeThemePair): boolean {
  const highlighter = getHighlighterIfLoaded();
  if (!highlighter) return false;
  const themes = highlighter.getLoadedThemes();
  return (
    themes.includes(pair.light) &&
    themes.includes(pair.dark) &&
    highlighter.getLoadedLanguages().includes(lang)
  );
}

/// Grammars loaded at startup — the languages this app is used on. Measured in
/// the app, all of these together attach in ~54ms because the loaders run in
/// parallel, which is cheaper than the single worst grammar in Shiki's bundle
/// (Ruby is ~390ms on its own, since it drags in HTML, CSS, JS and SQL for its
/// embedded syntaxes).
///
/// So this is not a "preload everything" list and must not become one. It is
/// the set common enough that paying for it once at startup beats making the
/// reader wait on first open. Anything absent still loads lazily on mount and
/// costs only its own grammar.
///
/// Markdown makes the list do double duty. Its own grammar is cheap and pulls
/// in nothing, but a fenced block is highlighted by *delegating* to the fence's
/// language — and when that grammar isn't attached the fence silently comes
/// back as one flat, uncoloured token rather than erroring. Since a `.md` file
/// can't declare its fences up front, the languages here are exactly the ones
/// whose fences render correctly inside one.
export const COMMON_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "json",
  "css",
  "html",
  "markdown",
  "yaml",
  "bash",
  "rust",
  "go",
  "sql",
  "toml",
];

/// Attaches the theme pair, Shiki's engine, and the common grammars before any
/// code is on screen, so opening a diff or a read is instant for the languages
/// that actually come up.
///
/// Called once at startup rather than per view, and deliberately not awaited —
/// nothing blocks on it, and any view whose language is missing still loads
/// what it needs on mount.
export function warmHighlighter(pair: CodeThemePair): void {
  void preloadHighlighter({
    themes: [pair.light, pair.dark],
    langs: COMMON_LANGS,
  }).catch(() => {
    // Best-effort: every view still loads what it needs on mount.
  });
}

/// Resolves when `lang` and `pair` are both attached to the shared highlighter.
///
/// Every code surface must gate its mount on this. `FileDiff` and `File` kick
/// off their own load when they hydrate without one, but drop the promise and
/// never re-render when it resolves — so a premature mount paints an empty or
/// unhighlighted `<pre>` and stays that way until something remounts it.
///
/// The synchronous seed is what keeps an already-warm surface from flashing a
/// placeholder: the common case is a second diff in a language already on
/// screen, which must mount highlighted on its first frame.
export function useHighlighter(lang: string, pair: CodeThemePair): boolean {
  const [ready, setReady] = useState(() => canTokenize(lang, pair));

  useEffect(() => {
    if (canTokenize(lang, pair)) {
      setReady(true);
      return;
    }

    // A pending state is reachable in normal use: switching theme, or a second
    // view whose language differs from the one already loaded.
    setReady(false);

    let cancelled = false;
    preloadHighlighter({ themes: [pair.light, pair.dark], langs: [lang] })
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        // A language Shiki can't resolve renders as plain text rather than
        // holding the placeholder open forever.
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [lang, pair.light, pair.dark]);

  return ready;
}
