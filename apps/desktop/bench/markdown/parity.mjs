// What Words draws for each shape our Streamdown plugins handle today
// (markdownPlugins.ts, codePlugin.ts, Markdown.tsx). Run from apps/desktop:
// `node bench/markdown/parity.mjs`. The React component renders through the
// same renderer, with raw HTML omitted, as here.
import { createHtmlRenderer } from "@pierre/words/html";

const CASES = {
  "bare host (rehypeBareUrls)": "see drayhq.com/docs and github.com/foo/bar",
  "www. autolink": "see www.example.com",
  "bare absolute path (rehypeFilePaths)": "edit /Users/me/app/src/a.ts:12 now",
  "bare relative path (rehypeFilePaths)": "edit src/components/chat/Markdown.tsx now",
  "file link, encoded, with locator (anchorToFile)": "[Footer.js](/Users/me/My%20Project/Footer.js:12)",
  "relative file link": "[a](src/a.ts)",
  "Greptile badge: image in a # link (harden)": "[![P1](https://img.shields.io/badge/P1-red)](#)",
  "raw block HTML (rehype-raw + sanitize)": "<details><summary>More</summary>\n\nhidden **text**\n\n</details>",
  "raw inline HTML": "a<br>b <kbd>Ctrl</kbd> <sub>x</sub>",
  "local image (rehypeLocalImages)": "![shot](/Users/me/.dray/browser/recordings/x/a.png)",
  "file:// image (rehypeFileImageUrls)": "![shot](file:///tmp/a.png)",
  "javascript: link": "[x](javascript:alert(1))",
  "task list": "- [x] done\n- [ ] todo",
  strikethrough: "~~gone~~",
  footnote: "text[^1]\n\n[^1]: note",
  "angle autolink": "<https://a.com>",
  "table cell": "| a | b |\n|---|---|\n| 1 | 2 |",
};

const strip = (html) => html.trim().replace(/ data-markdown="[a-z-]+"/g, "");
const renderer = createHtmlRenderer({ lineNumbers: false });
for (const [name, md] of Object.entries(CASES)) {
  console.log(`--- ${name}\n${strip(renderer.render(md, false, false).html)}`);
}
console.log(`--- streaming, incomplete\n${strip(renderer.render("**bold and `code", true, true).html)}`);
