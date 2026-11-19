import pierreDark from "@pierre/highlights/themes/pierre-dark";
import pierreLight from "@pierre/highlights/themes/pierre-light";
import { createHighlightsPlugin } from "@pierre/words/highlights";
import { escapeHtml } from "@pierre/words/html";
import { Markdown as Words, type Components } from "@pierre/words/react";
import { memo, type MouseEvent } from "react";

import { useChatSession } from "@/hooks/useChatSession";
import { openPath } from "@/hooks/useDocs";
import { absolutePath, isFilePath, isRelativePath, splitLocator } from "@/lib/filePath";
import { openLink } from "@/lib/openLink";
import { cn } from "@/lib/utils";

import "./words.css";

/// The chat's markdown drawn by Pierre's Words instead of Streamdown, behind the
/// dev switch in `lib/markdownRenderer`. A spike for the benchmark, not a port:
/// Words' hooks take and return HTML strings, so every React override the
/// Streamdown path carries — the table's copy menu, `FilePathSpan`'s mentions,
/// recordings and screenshots — has no way in here.
export type WordsMarkdownProps = {
  children: string;
  streaming?: boolean;
  linkFilePaths?: boolean;
  className?: string;
  /// No element hooks at all. Words extends its output in place only while no
  /// hook can rewrite it, so the benchmark measures this beside the hooked one.
  bare?: boolean;
};

// Words' own highlighter, not the shared Shiki one: its plugin contract is
// synchronous, and a highlighter that is not loaded yet has no way to ask for
// a re-render later. Pierre's pair only — the user's code-theme pick is not
// wired into this spike.
const CODE = {
  code: createHighlightsPlugin({ themes: { light: pierreLight, dark: pierreDark } }),
};
const CONTROLS = { code: { copy: true, download: false } };

/// Wraps each cell's content in the block its width cap rides on — the same
/// job `rehypeTableCells` does for Streamdown.
const cell = (html: string) => {
  const open = html.indexOf(">") + 1;
  const close = html.lastIndexOf("</");
  return `${html.slice(0, open)}<div class="dray-table-cell">${html.slice(open, close)}</div>${html.slice(close)}`;
};

const BASE: Components = {
  table: (html) => `<div class="md-table-scroll my-4">${html}</div>`,
  td: cell,
  th: cell,
};

/// Marks a link whose href names a file, so the click handler opens it in the
/// app — the job `anchorToFile` does on the Streamdown path. Bare paths in
/// prose are not found: that needs the text nodes, which hooks never see.
const WITH_FILE_LINKS: Components = {
  ...BASE,
  a: (html) => {
    const href = /href="([^"]*)"/.exec(html)?.[1];
    if (!href) return html;
    let decoded = href;
    try {
      decoded = decodeURIComponent(href.replaceAll("&amp;", "&"));
    } catch {
      // A malformed escape is still a link.
    }
    const { path, line } = splitLocator(decoded);
    if (!isFilePath(path) && !isRelativePath(path)) return html;
    const attrs = `data-file-path="${escapeHtml(path)}"${line ? ` data-line="${line}"` : ""}`;
    return html.replace("<a ", `<a ${attrs} `);
  },
};

function WordsMarkdownImpl({
  children,
  streaming = false,
  linkFilePaths = false,
  className,
  bare = false,
}: WordsMarkdownProps) {
  const { cwd, sessionId } = useChatSession();

  // Words owns the DOM under its root, so links are caught by delegation
  // rather than by an `a` component.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a[href]");
    // A footnote's `#fn-1` jumps within the message, as the browser does it.
    if (!a || a.getAttribute("href")?.startsWith("#")) return;
    e.preventDefault();
    const file = a.getAttribute("data-file-path");
    if (file) {
      const path = absolutePath(file, cwd);
      const line = Number(a.getAttribute("data-line")) || undefined;
      if (path) openPath(sessionId, path, line);
      return;
    }
    openLink(a.getAttribute("href") ?? "", e);
  };

  return (
    <Words
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      plugins={CODE}
      controls={CONTROLS}
      lineNumbers={false}
      components={bare ? undefined : linkFilePaths ? WITH_FILE_LINKS : BASE}
      onClick={onClick}
      className={cn(
        "dray-words group/md text-chat leading-normal",
        "[&_h1]:text-chat [&_h2]:text-chat [&_h3]:text-chat [&_h4]:text-chat [&_h5]:text-chat [&_h6]:text-chat",
        "[&_p]:text-chat [&_li]:text-chat [&_blockquote]:text-chat [&_td]:text-chat [&_th]:text-chat",
        "[&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:mt-3 [&_h3]:mb-1.5",
        "[&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold [&_h1]:tracking-normal [&_h2]:tracking-normal",
        "[&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_li]:my-1 [&_ul]:ps-6 [&_ol]:ps-6",
        "[&_a]:wrap-anywhere [&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
        "[&_code]:font-mono [&_code]:text-code [&_pre]:font-mono [&_pre_code]:text-code",
        "[&_.dray-table-cell]:max-w-md [&_.dray-table-cell]:wrap-break-word",
        "[&_th]:whitespace-normal [&_th]:text-left [&_td]:align-top",
        "[&_th]:border-0 [&_td]:border-0 [&_th]:border-b [&_th]:border-border/60",
        "[&_tbody_tr]:border-b [&_tbody_tr]:border-border/30",
        "[&_th]:px-4 [&_th]:py-2 [&_td]:px-4 [&_td]:py-2",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      {children}
    </Words>
  );
}

export default memo(WordsMarkdownImpl);
