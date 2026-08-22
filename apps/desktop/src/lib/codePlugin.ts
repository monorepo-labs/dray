import { getHighlighterIfLoaded, preloadHighlighter } from "@pierre/diffs";
import type { CodeHighlighterPlugin, HighlightOptions, HighlightResult } from "@streamdown/code";

import type { CodeThemePair } from "@/lib/codeTheme";

/// A Streamdown code-highlighter backed by the same highlighter `@pierre/diffs`
/// uses, replacing `@streamdown/code`'s own.
///
/// Two reasons it has to be ours rather than the stock plugin:
///
/// - The stock plugin builds a *second* Shiki instance with its own theme and
///   grammar registries. That doubles the grammar loading for languages already
///   on screen in a diff, which is where the slowness comes from — the work is
///   duplicated, not inherently expensive.
/// - That registry is Shiki's bundled set only, so `pierre-*` themes fail there
///   outright ("Theme `pierre-light` is not included in this bundle"). Sharing
///   one highlighter is what makes the Pierre themes work in code blocks at all.
///
/// The plugin interface is structural, so this satisfies it without depending on
/// the stock implementation.
export function createSharedCodePlugin(pair: CodeThemePair): CodeHighlighterPlugin {
  const themes: [string, string] = [pair.light, pair.dark];

  // Results are cached by the same key Streamdown would use, since `highlight`
  // is called on every render of every block and re-tokenizing is the expensive
  // part. Pending callbacks are held per key so N blocks of one language share
  // a single load rather than each starting their own.
  const done = new Map<string, HighlightResult>();
  const waiting = new Map<string, Set<(result: HighlightResult) => void>>();

  const keyOf = (code: string, lang: string) =>
    `${lang}:${themes[0]}:${themes[1]}:${code.length}:${code.slice(0, 100)}`;

  return {
    name: "shiki",
    type: "code-highlighter",

    // The highlighter resolves any language Shiki bundles, and falls back to
    // plain text for the rest — so claiming support is honest for both.
    supportsLanguage: () => true,
    getSupportedLanguages: () => [],
    getThemes: () => themes as never,

    highlight(
      { code, language }: HighlightOptions,
      callback?: (result: HighlightResult) => void,
    ): HighlightResult | null {
      // A fence's info string is already a language id or alias, which Shiki
      // resolves itself — passing it through `getFiletypeFromFileName` would
      // map it as a file *extension* instead, turning "typescript" and "rust"
      // into plain text while only "ts" happened to work.
      const lang = language ? language.trim().toLowerCase() : "text";
      const key = keyOf(code, lang);

      const cached = done.get(key);
      if (cached) return cached;

      const tokenize = (): HighlightResult | null => {
        const highlighter = getHighlighterIfLoaded();
        if (!highlighter) return null;

        // Both themes must be attached, not just the highlighter present. A
        // warm highlighter with an unattached theme still tokenizes — it just
        // returns every token with an empty style, which then gets cached as if
        // it were a real result and the block stays grey forever.
        const loadedThemes = highlighter.getLoadedThemes();
        if (!themes.every((theme) => loadedThemes.includes(theme))) return null;

        // The grammar loads independently of the themes, and a diff's preload
        // warms only its own language — so `ts` is routinely still missing here
        // even with everything else ready. Falling back to plain text and
        // caching it is what left blocks permanently grey; report not-ready
        // instead and let the caller await the real grammar.
        if (!highlighter.getLoadedLanguages().includes(lang)) return null;

        const result = highlighter.codeToTokens(code, {
          lang,
          themes: { light: themes[0], dark: themes[1] },
        }) as HighlightResult;
        done.set(key, result);
        return result;
      };

      const immediate = tokenize();
      if (immediate) return immediate;

      if (callback) {
        let pending = waiting.get(key);
        if (!pending) {
          pending = new Set();
          waiting.set(key, pending);

          preloadHighlighter({ themes, langs: [lang] })
            .then(() => {
              const result = tokenize();
              const callbacks = waiting.get(key);
              waiting.delete(key);
              if (!result || !callbacks) return;
              for (const fn of callbacks) fn(result);
            })
            .catch(() => {
              // A language Shiki can't resolve — an invented fence tag, say.
              // The block stays as the plain text it already renders as, and
              // the key is dropped so a later block of a real language isn't
              // blocked behind it.
              waiting.delete(key);
            });
        }
        pending.add(callback);
      }

      return null;
    },
  } as CodeHighlighterPlugin;
}
