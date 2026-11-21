import JavaScriptCore
import SwiftUI

/// Colours code by its language: highlight.js 11.12's common build (36 languages),
/// bundled as `highlight.min.js` and run in JavaScriptCore, coloured after the
/// desktop's pierre-dark. An actor, so the work stays off the main thread and the
/// one `JSContext` is never entered twice at once.
actor Highlighter {
    static let shared = Highlighter()

    /// Past this, plain text: highlight.js on a megabyte takes seconds.
    private static let limit = 200_000
    private lazy var lines: JSValue? = {
        guard let url = Bundle.main.url(forResource: "highlight.min", withExtension: "js"),
              let js = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext() else { return nil }
        context.evaluateScript(js)
        context.evaluateScript(Self.shim)
        return context.objectForKeyedSubscript("drayLines")
    }()
    private var cache: [String: [AttributedString]] = [:]

    /// `code` split on newlines, each line coloured, or nil where `lang` names no
    /// grammar here. A nil `lang` guesses, and answers nil on a weak guess.
    func lines(_ code: String, lang: String?) -> [AttributedString]? {
        guard code.utf8.count <= Self.limit, !code.isEmpty else { return nil }
        let key = "\(lang ?? "?")\u{0}\(code)"
        if let hit = cache[key] { return hit }
        guard let json = lines?.call(withArguments: [code, lang ?? NSNull()])?.toString(),
              let data = json.data(using: .utf8),
              let read = try? JSONDecoder().decode([[[String]]].self, from: data) else { return nil }
        let out = read.map { runs in
            runs.reduce(into: AttributedString()) { line, run in
                var piece = AttributedString(run[0])
                if let color = Self.color(run[1]) { piece.foregroundColor = color }
                line += piece
            }
        }
        // ponytail: dropped whole when full, an LRU if reopening big diffs turns out slow.
        if cache.count > 64 { cache.removeAll() }
        cache[key] = out
        return out
    }

    /// The whole block as one string, for a chat code block.
    func text(_ code: String, lang: String?) -> AttributedString? {
        guard let rows = lines(code, lang: lang) else { return nil }
        return rows.dropFirst().reduce(into: rows[0]) { $0 += "\n"; $0 += $1 }
    }

    /// Runs `hljs` and flattens its nested `<span>`s into lines of `[text, scope]`:
    /// a span may cross a newline, as a block comment does, so the scope stack
    /// carries over, and a CRLF line's CR is dropped, since drawn it breaks the line. A span highlight.js nests for a sublanguage names no scope and
    /// takes its parent's. A guess leaves out stylesheets, which took short Swift for
    /// CSS, and JSON is caught by parsing, since its guesses score low.
    private static let shim = #"""
    var guessable = ["typescript", "javascript", "python", "rust", "swift", "go", "bash", "yaml",
      "ruby", "java", "kotlin", "c", "cpp", "csharp", "sql", "diff", "xml", "markdown"];
    function drayLines(code, lang) {
      var r;
      if (lang == null) {
        try { JSON.parse(code); if (/^\s*[\[{]/.test(code)) lang = "json"; } catch (e) {}
      }
      if (lang == null) {
        r = hljs.highlightAuto(code, guessable);
        if (r.relevance < 5) return null;
      } else if (hljs.getLanguage(lang)) {
        r = hljs.highlight(code, { language: lang, ignoreIllegals: true });
      } else return null;
      var lines = [[]], stack = [""], re = /<span class="([^"]*)">|<\/span>|[^<]+/g, m;
      var unescape = function (s) {
        return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
      };
      while ((m = re.exec(r.value))) {
        if (m[1] !== undefined) stack.push(m[1].indexOf("hljs-") === 0 ? m[1].slice(5) : stack[stack.length - 1]);
        else if (m[0] === "</span>") stack.pop();
        else unescape(m[0]).split("\n").forEach(function (part, i, parts) {
          if (i > 0) lines.push([]);
          if (i < parts.length - 1) part = part.replace(/\r$/, "");
          if (part) lines[lines.length - 1].push([part, stack[stack.length - 1]]);
        });
      }
      return JSON.stringify(lines);
    }
    """#

    /// pierre-dark's colour for a highlight.js scope, the nearest TextMate scope's.
    private static func color(_ scope: String) -> Color? {
        // `title function_`, `title class_`, `variable language_`: the suffix decides.
        if scope.hasSuffix("class_") { return Color(hex: 0xD568EA) }
        if scope.hasSuffix("language_") { return Color(hex: 0xFFAB16) }
        switch scope.split(separator: " ").first ?? "" {
        case "comment", "quote": return Color(hex: 0x737373)
        case "string", "regexp", "symbol", "char", "link", "code": return Color(hex: 0x5ECC71)
        case "number", "literal": return Color(hex: 0x68CDF2)
        case "keyword", "selector-tag", "bullet", "doctag", "emphasis": return Color(hex: 0xFF678D)
        case "type", "built_in", "class": return Color(hex: 0xD568EA)
        case "title", "selector-id": return Color(hex: 0x9D6AFB)
        case "variable", "property", "template-variable": return Color(hex: 0xFFA359)
        case "attr", "attribute", "name", "section": return Color(hex: 0xFF855E)
        case "params": return Color(hex: 0xA3A3A3)
        case "meta": return Color(hex: 0x69B1FF)
        case "strong": return Color(hex: 0xFFD452)
        case "operator": return Color(hex: 0x08C0EF)
        case "punctuation", "tag": return Color(hex: 0x636363)
        case "addition": return Theme.add
        case "deletion": return Theme.destructive
        default: return nil
        }
    }
}

/// The grammar a file's name asks for: its extension, which highlight.js knows
/// as an alias (`ts`, `rs`, `md`, `yml`), or the whole name where it has none (`Makefile`).
func highlightLanguage(_ path: String) -> String {
    let name = (path as NSString).lastPathComponent.lowercased()
    guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return name }
    return String(name[name.index(after: dot)...])
}

/// A chat code block, coloured once its highlight lands; plain until then and
/// for a language highlight.js doesn't know.
struct CodeBlock: View {
    let code: String
    let lang: String

    @State private var colored: (code: String, text: AttributedString)?

    var body: some View {
        Group {
            if let colored, colored.code == code { Text(colored.text) } else { Text(code) }
        }
        .task(id: code) {
            if let text = await Highlighter.shared.text(code, lang: lang.isEmpty ? nil : lang) {
                colored = (code, text)
            }
        }
    }
}
