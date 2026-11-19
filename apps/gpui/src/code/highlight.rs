//! Tree-sitter highlighting: a language from a fence tag or a path, and the
//! token spans of a text, with no GPUI in sight.

use std::ops::Range;
use std::sync::OnceLock;

use tree_sitter_highlight::{HighlightConfiguration, HighlightEvent, Highlighter};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Lang {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Json,
    Bash,
    Go,
    Css,
    Html,
    Yaml,
    Toml,
}

const LANGS: usize = 12;

impl Lang {
    /// A fence's info string. It is a language id, never a filename: mapping it
    /// through extensions is what turned `typescript` into plain text in the
    /// React app (rendering-code.md).
    pub fn from_fence(info: &str) -> Option<Lang> {
        let tag = info.split_whitespace().next()?.to_ascii_lowercase();
        Some(match tag.as_str() {
            "rust" | "rs" => Lang::Rust,
            "typescript" | "ts" | "mts" | "cts" => Lang::TypeScript,
            "tsx" => Lang::Tsx,
            "javascript" | "js" | "jsx" | "mjs" | "cjs" | "node" => Lang::JavaScript,
            "python" | "py" | "python3" => Lang::Python,
            "json" | "jsonc" | "json5" => Lang::Json,
            "bash" | "sh" | "shell" | "zsh" | "console" | "shellscript" => Lang::Bash,
            "go" | "golang" => Lang::Go,
            "css" => Lang::Css,
            "html" | "xml" | "svg" => Lang::Html,
            "yaml" | "yml" => Lang::Yaml,
            "toml" => Lang::Toml,
            _ => return None,
        })
    }

    /// A path's extension (or a well-known bare name), for `Read` and `Edit`.
    pub fn from_path(path: &str) -> Option<Lang> {
        let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
        match name {
            "Cargo.lock" => return Some(Lang::Toml),
            ".bashrc" | ".zshrc" | ".profile" | ".zprofile" => return Some(Lang::Bash),
            _ => {}
        }
        let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
        Some(match ext.as_str() {
            "rs" => Lang::Rust,
            "ts" | "mts" | "cts" => Lang::TypeScript,
            "tsx" => Lang::Tsx,
            "js" | "jsx" | "mjs" | "cjs" => Lang::JavaScript,
            "py" | "pyi" => Lang::Python,
            "json" | "jsonc" | "jsonl" => Lang::Json,
            "sh" | "bash" | "zsh" => Lang::Bash,
            "go" => Lang::Go,
            "css" => Lang::Css,
            "html" | "htm" | "xml" | "svg" => Lang::Html,
            "yaml" | "yml" => Lang::Yaml,
            "toml" => Lang::Toml,
            _ => return None,
        })
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// What a span is drawn as. One colour each in a palette; the capture names
/// tree-sitter reports are folded onto these in [`CAPTURES`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Token {
    Comment,
    String,
    Escape,
    Regexp,
    Number,
    Constant,
    ConstantName,
    Keyword,
    Function,
    Type,
    Variable,
    VariableBuiltin,
    Parameter,
    Property,
    Namespace,
    Operator,
    Punctuation,
    Tag,
    Attribute,
    Key,
}

impl Token {
    pub const COUNT: usize = 20;
}

/// Capture name → token. tree-sitter-highlight matches a capture to the longest
/// listed name its dotted parts start with, so `function.method` lands on
/// `function` unless it is listed itself. Order is load-bearing only in that
/// the index into this table is what the highlighter hands back.
const CAPTURES: &[(&str, Token)] = &[
    ("comment", Token::Comment),
    ("string", Token::String),
    ("string.special.key", Token::Key),
    ("string.escape", Token::Escape),
    ("escape", Token::Escape),
    ("string.regexp", Token::Regexp),
    ("number", Token::Number),
    ("float", Token::Number),
    ("boolean", Token::Number),
    ("constant.builtin", Token::Number),
    ("constant", Token::ConstantName),
    ("character", Token::String),
    ("keyword", Token::Keyword),
    ("storageclass", Token::Keyword),
    ("conditional", Token::Keyword),
    ("repeat", Token::Keyword),
    ("include", Token::Keyword),
    ("exception", Token::Keyword),
    ("function", Token::Function),
    ("function.macro", Token::Function),
    ("method", Token::Function),
    ("constructor", Token::Type),
    ("type", Token::Type),
    ("variable", Token::Variable),
    ("variable.builtin", Token::VariableBuiltin),
    ("variable.parameter", Token::Parameter),
    ("parameter", Token::Parameter),
    ("property", Token::Property),
    ("field", Token::Property),
    ("label", Token::Constant),
    ("module", Token::Namespace),
    ("namespace", Token::Namespace),
    ("operator", Token::Operator),
    ("punctuation", Token::Punctuation),
    ("punctuation.special", Token::Keyword),
    ("tag", Token::Tag),
    ("attribute", Token::Attribute),
    ("embedded", Token::Variable),
];

/// One coloured run, byte offsets into the text that was highlighted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
    pub range: Range<usize>,
    pub token: Token,
}

static CONFIGS: [OnceLock<Option<HighlightConfiguration>>; LANGS] = [const { OnceLock::new() }; LANGS];

/// The language's compiled queries, built once on first use (a few ms each, so
/// a cold grammar costs one fence, not every one).
fn config(lang: Lang) -> Option<&'static HighlightConfiguration> {
    CONFIGS[lang.index()]
        .get_or_init(|| {
            let ts_highlights =
                || format!("{}\n{}", tree_sitter_typescript::HIGHLIGHTS_QUERY, tree_sitter_javascript::HIGHLIGHT_QUERY);
            let jsx_highlights = || {
                format!("{}\n{}", tree_sitter_javascript::JSX_HIGHLIGHT_QUERY, tree_sitter_javascript::HIGHLIGHT_QUERY)
            };
            let tsx_highlights = || format!("{}\n{}", tree_sitter_javascript::JSX_HIGHLIGHT_QUERY, ts_highlights());
            let (language, name, highlights, injections, locals): (tree_sitter_language::LanguageFn, _, String, _, _) =
                match lang {
                    Lang::Rust => (
                        tree_sitter_rust::LANGUAGE,
                        "rust",
                        tree_sitter_rust::HIGHLIGHTS_QUERY.into(),
                        tree_sitter_rust::INJECTIONS_QUERY,
                        "",
                    ),
                    // TypeScript's query extends JavaScript's rather than
                    // repeating it, so both go in, the extension first so its
                    // patterns win.
                    Lang::TypeScript => (
                        tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
                        "typescript",
                        ts_highlights(),
                        tree_sitter_javascript::INJECTIONS_QUERY,
                        tree_sitter_typescript::LOCALS_QUERY,
                    ),
                    Lang::Tsx => (
                        tree_sitter_typescript::LANGUAGE_TSX,
                        "tsx",
                        tsx_highlights(),
                        tree_sitter_javascript::INJECTIONS_QUERY,
                        tree_sitter_typescript::LOCALS_QUERY,
                    ),
                    Lang::JavaScript => (
                        tree_sitter_javascript::LANGUAGE,
                        "javascript",
                        jsx_highlights(),
                        tree_sitter_javascript::INJECTIONS_QUERY,
                        tree_sitter_javascript::LOCALS_QUERY,
                    ),
                    Lang::Python => {
                        (tree_sitter_python::LANGUAGE, "python", tree_sitter_python::HIGHLIGHTS_QUERY.into(), "", "")
                    }
                    // A key is captured as the key and then again by the
                    // general `(string)` pattern, and the later one is the
                    // innermost. Repeating the key pattern last makes it win.
                    Lang::Json => (
                        tree_sitter_json::LANGUAGE,
                        "json",
                        format!("{}\n(pair key: (_) @string.special.key)", tree_sitter_json::HIGHLIGHTS_QUERY),
                        "",
                        "",
                    ),
                    Lang::Bash => {
                        (tree_sitter_bash::LANGUAGE, "bash", tree_sitter_bash::HIGHLIGHT_QUERY.into(), "", "")
                    }
                    Lang::Go => (tree_sitter_go::LANGUAGE, "go", tree_sitter_go::HIGHLIGHTS_QUERY.into(), "", ""),
                    Lang::Css => (tree_sitter_css::LANGUAGE, "css", tree_sitter_css::HIGHLIGHTS_QUERY.into(), "", ""),
                    Lang::Html => (
                        tree_sitter_html::LANGUAGE,
                        "html",
                        tree_sitter_html::HIGHLIGHTS_QUERY.into(),
                        tree_sitter_html::INJECTIONS_QUERY,
                        "",
                    ),
                    Lang::Yaml => {
                        (tree_sitter_yaml::LANGUAGE, "yaml", tree_sitter_yaml::HIGHLIGHTS_QUERY.into(), "", "")
                    }
                    Lang::Toml => {
                        (tree_sitter_toml_ng::LANGUAGE, "toml", tree_sitter_toml_ng::HIGHLIGHTS_QUERY.into(), "", "")
                    }
                };
            let mut config = HighlightConfiguration::new(language.into(), name, &highlights, injections, locals)
                .map_err(|err| log::warn!("{name} highlight query: {err}"))
                .ok()?;
            let names: Vec<&str> = CAPTURES.iter().map(|(n, _)| *n).collect();
            config.configure(&names);
            Some(config)
        })
        .as_ref()
}

/// Token spans for `code`, sorted and non-overlapping, innermost capture
/// winning. Text with no capture over it has no span and draws in the
/// palette's foreground. An unknown or broken grammar yields no spans, so the
/// code still shows, uncoloured.
pub fn highlight(lang: Lang, code: &str) -> Vec<Span> {
    let Some(root) = config(lang) else { return Vec::new() };
    let mut highlighter = Highlighter::new();
    let injected = |name: &str| Lang::from_fence(name).and_then(config);
    let Ok(events) = highlighter.highlight(root, code.as_bytes(), None, None, injected) else { return Vec::new() };
    let mut spans: Vec<Span> = Vec::new();
    let mut stack = Vec::new();
    for event in events {
        let Ok(event) = event else { break };
        match event {
            HighlightEvent::HighlightStart(h) => stack.push(CAPTURES[h.0].1),
            HighlightEvent::HighlightEnd => {
                stack.pop();
            }
            HighlightEvent::Source { start, end } => {
                let Some(&token) = stack.last() else { continue };
                match spans.last_mut() {
                    Some(last) if last.token == token && last.range.end == start => last.range.end = end,
                    _ => spans.push(Span { range: start..end, token }),
                }
            }
        }
    }
    spans
}

/// Byte ranges of each line of `text`, newline excluded. A trailing newline
/// ends the last line rather than opening an empty one, the way `similar` and
/// git count lines, so a diff's line numbers index this directly.
pub fn line_ranges(text: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            out.push(start..i);
            start = i + 1;
        }
    }
    if start < text.len() {
        out.push(start..text.len());
    }
    out
}

/// `spans` cut to one line and made relative to its start.
pub fn spans_in(spans: &[Span], line: &Range<usize>) -> Vec<Span> {
    let first = spans.partition_point(|s| s.range.end <= line.start);
    let mut out = Vec::new();
    for span in &spans[first..] {
        if span.range.start >= line.end {
            break;
        }
        let start = span.range.start.max(line.start) - line.start;
        let end = span.range.end.min(line.end) - line.start;
        if start < end {
            out.push(Span { range: start..end, token: span.token });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fence_tags_are_language_ids() {
        assert_eq!(Lang::from_fence("typescript"), Some(Lang::TypeScript));
        assert_eq!(Lang::from_fence("rust ignore"), Some(Lang::Rust));
        assert_eq!(Lang::from_fence("sh"), Some(Lang::Bash));
        assert_eq!(Lang::from_fence("mermaid"), None);
    }

    #[test]
    fn paths_map_by_extension() {
        assert_eq!(Lang::from_path("/x/src/App.tsx"), Some(Lang::Tsx));
        assert_eq!(Lang::from_path("Cargo.lock"), Some(Lang::Toml));
        assert_eq!(Lang::from_path("Makefile"), None);
    }

    #[test]
    fn every_grammar_compiles_its_queries() {
        for lang in [
            Lang::Rust,
            Lang::TypeScript,
            Lang::Tsx,
            Lang::JavaScript,
            Lang::Python,
            Lang::Json,
            Lang::Bash,
            Lang::Go,
            Lang::Css,
            Lang::Html,
            Lang::Yaml,
            Lang::Toml,
        ] {
            assert!(config(lang).is_some(), "{lang:?}");
        }
    }

    #[test]
    fn colours_keywords_strings_and_comments() {
        let code = "// hi\nfn main() { let s = \"x\"; }\n";
        let spans = highlight(Lang::Rust, code);
        let token_at = |needle: &str| {
            let at = code.find(needle).unwrap();
            spans.iter().find(|s| s.range.contains(&at)).map(|s| s.token)
        };
        assert_eq!(token_at("// hi"), Some(Token::Comment));
        assert_eq!(token_at("fn"), Some(Token::Keyword));
        assert_eq!(token_at("main"), Some(Token::Function));
        assert_eq!(token_at("\"x\""), Some(Token::String));
        assert!(spans.windows(2).all(|w| w[0].range.end <= w[1].range.start));
    }

    #[test]
    fn json_keys_are_not_plain_strings() {
        let code = "{\"name\": \"dray\"}";
        let spans = highlight(Lang::Json, code);
        let token_at = |at: usize| spans.iter().find(|s| s.range.contains(&at)).map(|s| s.token);
        assert_eq!(token_at(1), Some(Token::Key));
        assert_eq!(token_at(10), Some(Token::String));
    }

    #[test]
    fn lines_split_like_git_counts_them() {
        assert_eq!(line_ranges("a\nb\n"), vec![0..1, 2..3]);
        assert_eq!(line_ranges("a\n\nb"), vec![0..1, 2..2, 3..4]);
        assert!(line_ranges("").is_empty());
    }

    #[test]
    fn spans_split_across_lines() {
        let spans = vec![Span { range: 2..7, token: Token::Comment }];
        assert_eq!(spans_in(&spans, &(0..4)), vec![Span { range: 2..4, token: Token::Comment }]);
        assert_eq!(spans_in(&spans, &(5..9)), vec![Span { range: 0..2, token: Token::Comment }]);
    }
}
