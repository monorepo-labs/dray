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

/// The regex engine every Shiki instance here runs on — the shared main-thread
/// highlighter and each pool worker alike. `getSharedHighlighter` reads it on
/// first creation only, so every creation site has to name it or the first one
/// to run decides for the rest.
///
/// WASM Oniguruma, not the library's default JavaScript engine, and the reason
/// is the webview: under JavaScriptCore the JS engine tokenizes at ~1ms/line
/// (2237 lines of TS = 2.2s, a full-file diff twice that) and translates each
/// grammar's regexes lazily on first use, ~1.9s for TypeScript, paid separately
/// by the main thread and by every worker. Measured in Safari 26.5 through this
/// app's own components. The same code on WASM: 230ms for those lines, 150ms
/// cold. V8 hides the gap (3x, not 10x), which is why a Chromium head never
/// showed it. The binary is base64-inlined in `shiki/wasm`, so nothing is fetched.
export const HIGHLIGHT_ENGINE = "shiki-wasm" as const;

/// Grammars loaded at startup — the languages this app is used on. Measured in
/// the app, all of these together attach in ~25ms because the loaders run in
/// parallel. Attach is the cheap half: it registers the grammar and nothing
/// more, where the first *tokenize* in a language is what compiles it.
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
  // After first paint: the WASM engine and fifteen grammars are no part of it.
  if ("requestIdleCallback" in window) window.requestIdleCallback(() => preload(pair));
  else setTimeout(() => preload(pair), 1000);
}

function preload(pair: CodeThemePair): void {
  void preloadHighlighter({
    themes: [pair.light, pair.dark],
    langs: COMMON_LANGS,
    preferredHighlighter: HIGHLIGHT_ENGINE,
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
  const [ready, setReady] = useState(() => poolWanted && canTokenize(lang, pair));

  useEffect(() => {
    // Before `ready` flips, since a view captures the pool when it mounts and
    // one mounted without it tokenizes on the main thread for good.
    wantPool();
    if (canTokenize(lang, pair)) {
      setReady(true);
      return;
    }

    // A pending state is reachable in normal use: switching theme, or a second
    // view whose language differs from the one already loaded.
    setReady(false);

    let cancelled = false;
    preloadHighlighter({
      themes: [pair.light, pair.dark],
      langs: [lang],
      preferredHighlighter: HIGHLIGHT_ENGINE,
    })
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

/// Whether a code view has ever asked for the diff worker pool. Its two workers
/// each boot a WASM Shiki with every common grammar, so `DiffWorkerPool` makes
/// them on the first diff rather than at launch.
let poolWanted = false;
const poolListeners = new Set<() => void>();

function wantPool(): void {
  if (poolWanted) return;
  poolWanted = true;
  for (const listener of poolListeners) listener();
}

export function subscribePool(listener: () => void): () => void {
  poolListeners.add(listener);
  return () => poolListeners.delete(listener);
}

export function isPoolWanted(): boolean {
  return poolWanted;
}
