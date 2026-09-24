import { getHighlighterIfLoaded, preloadHighlighter } from "@pierre/diffs";
import type { CodeHighlighterPlugin, HighlightOptions } from "streamdown";

import { HIGHLIGHT_ENGINE } from "@/hooks/useHighlighter";
import type { CodeThemePair } from "@/lib/codeTheme";

type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;

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

          preloadHighlighter({ themes, langs: [lang], preferredHighlighter: HIGHLIGHT_ENGINE })
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

/// How long a streaming code block must stop growing before it is tokenized.
const SETTLE_MS = 150;

/// `plugin`, for a message that is still streaming.
///
/// An open fence grows on every delta, and every length is a new cache key, so
/// the plain plugin tokenized the whole block again on the main thread for each
/// token — measured at 113 tokenizes and 2.2s over one 130-line fence — and kept
/// every prefix in its cache for good. Here a block is tokenized only once it
/// has stopped growing for `SETTLE_MS`, which a closed fence always does, and
/// that one result lands in the plain plugin's cache where the committed message
/// finds it. Meanwhile the block draws the lines an earlier tokenize already
/// coloured and the rest plain. Every line of a prefix but its last is final,
/// since a grammar's state only runs forward.
export function streamingCodePlugin(plugin: CodeHighlighterPlugin): CodeHighlighterPlugin {
  // Newest first, and few: only the blocks streaming right now read these.
  const settled: { lang: string; code: string; result: HighlightResult }[] = [];
  type Callback = (result: HighlightResult) => void;
  const pending: {
    lang: string;
    code: string;
    timer?: ReturnType<typeof setTimeout>;
    callback?: Callback;
    /// Earlier requests this one took over, each owed a result for its own text.
    superseded: { code: string; callback?: Callback }[];
  }[] = [];

  const plainLine = (content: string) => [
    { content, color: "inherit", bgColor: "transparent", htmlStyle: {}, offset: 0 },
  ];

  const partial = (code: string, lang: string): HighlightResult => {
    const base = settled.find((s) => s.lang === lang && code.startsWith(s.code));
    const keep = base ? Math.max(0, base.result.tokens.length - 1) : 0;
    const plain = code.split("\n").slice(keep).map(plainLine);
    return {
      ...(base?.result ?? { bg: "transparent", fg: "inherit" }),
      tokens: [...(base?.result.tokens.slice(0, keep) ?? []), ...plain],
    } as HighlightResult;
  };

  /// `result`, cut back to `code`, a prefix of what it tokenized. Its last line
  /// keeps its colour only where it is a whole line of `result`.
  const cut = (result: HighlightResult, code: string): HighlightResult => {
    const lines = code.split("\n");
    const tokens = result.tokens.slice(0, lines.length);
    const last = lines.length - 1;
    if (tokens[last]?.map((t) => t.content).join("") !== lines[last]) {
      tokens[last] = plainLine(lines[last]) as (typeof tokens)[number];
    }
    return { ...result, tokens };
  };

  return {
    ...plugin,
    highlight(options: HighlightOptions, callback?: (result: HighlightResult) => void) {
      const { code } = options;
      const lang = options.language ? options.language.trim().toLowerCase() : "text";

      const done = settled.find((s) => s.lang === lang && s.code === code);
      if (done) return done.result;

      // A block growing takes over its own earlier wait rather than queueing
      // beside it — a request whose text extends a pending one is taken to be
      // that block. It may be another fence that happens to start with the
      // first one's text, so the earlier request still gets a result, cut from
      // this one's rather than tokenized again.
      const wait: (typeof pending)[number] = { lang, code, superseded: [] };
      const earlier = pending.findIndex((p) => p.lang === lang && code.startsWith(p.code));
      if (earlier >= 0) {
        const [prev] = pending.splice(earlier, 1);
        clearTimeout(prev.timer);
        wait.superseded = [...prev.superseded, { code: prev.code, callback: prev.callback }];
      }
      wait.callback = callback;

      wait.timer = setTimeout(() => {
        pending.splice(pending.indexOf(wait), 1);
        const deliver = (result: HighlightResult) => {
          settled.unshift({ lang, code, result });
          settled.length = Math.min(settled.length, 8);
          for (const s of wait.superseded) s.callback?.(cut(result, s.code));
          callback?.(result);
        };
        const result = plugin.highlight(options, deliver);
        if (result) deliver(result);
      }, SETTLE_MS);
      pending.push(wait);

      return partial(code, lang);
    },
  } as CodeHighlighterPlugin;
}
