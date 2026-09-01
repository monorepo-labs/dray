import { memo, useMemo } from "react";
import { Streamdown, type Components, type LinkSafetyConfig, type ThemeInput } from "streamdown";

import FileLink from "@/components/chat/FileLink";
import LinkDialog from "@/components/chat/LinkDialog";
import { MarkdownTable } from "@/components/chat/MarkdownTable";
import { useCodeTheme } from "@/hooks/useCodeTheme";
import { createSharedCodePlugin } from "@/lib/codePlugin";
import type { CodeThemePair } from "@/lib/codeTheme";
import { isFilePath } from "@/lib/filePath";
import {
  FILE_LINK_CLASS,
  FILE_PATH_CLASS,
  REHYPE_PLUGINS,
  REHYPE_PLUGINS_WITH_FILE_PATHS,
} from "@/lib/markdownPlugins";
import { cn } from "@/lib/utils";

type MarkdownProps = {
  children: string;
  /// True while deltas are still arriving, so incomplete blocks render as
  /// prose instead of flickering through half-parsed markdown.
  streaming?: boolean;
  /// Element overrides, for a caller whose markdown holds something this
  /// renderer cannot resolve on its own — an issue description, whose images
  /// and files sit behind the tracker's auth and have to be fetched with a key.
  components?: Components;
  /// Draw an absolute path in the prose as something that opens.
  ///
  /// Off by default and on for the assistant's own messages alone. Everywhere
  /// else this renders — an issue description, a PR review comment — the paths
  /// come from somebody else's checkout, so a link there would offer to open a
  /// file the reader has not got.
  linkFilePaths?: boolean;
  className?: string;
};

// A plugin's `getThemes()` outranks the `shikiTheme` prop, so the pair has to
// reach it through construction. Cached per pair because each instance owns its
// own token cache — rebuilding one on every render would throw that away and
// re-tokenize every visible block.
const pluginCache = new Map<string, ReturnType<typeof createSharedCodePlugin>>();

function codePlugin(pair: CodeThemePair) {
  const key = `${pair.light}:${pair.dark}`;
  let plugin = pluginCache.get(key);
  if (!plugin) {
    plugin = createSharedCodePlugin(pair);
    pluginCache.set(key, plugin);
  }
  return plugin;
}

// Copy is the only control worth keeping, and code's is the only one of
// Streamdown's used: the table's copy control is ours ([MarkdownTable]), whose
// format menu opens on hover where Streamdown's needs a click. Download and
// fullscreen are off entirely rather than hidden with CSS, so they can't be
// tabbed to either.
const CONTROLS = { table: false, code: { copy: true, download: false } };

// Streamdown's own confirm is kept on — a link in agent output is worth a
// second look — but its Open button calls `window.open`, which does nothing in
// a Tauri webview, so the dialog is ours.
const LINK_SAFETY: LinkSafetyConfig = {
  enabled: true,
  renderModal: (props) => <LinkDialog {...props} />,
};

/// Streamdown is built on the same shadcn tokens as the rest of the app, so it
/// inherits the palette; only typography scale is ours to set.
function MarkdownImpl({
  children,
  streaming = false,
  components,
  linkFilePaths = false,
  className,
}: MarkdownProps) {
  // Shiki takes a [light, dark] pair and picks by the `.dark` class our theme
  // already sets, so this needs no mode of its own — only the user's pick.
  const { pair } = useCodeTheme();
  const shikiTheme = useMemo(
    (): [ThemeInput, ThemeInput] => [pair.light as ThemeInput, pair.dark as ThemeInput],
    [pair.light, pair.dark],
  );
  const plugins = useMemo(() => ({ code: codePlugin(pair) }), [pair]);

  // The caller's own overrides win, so a surface needing its own `span` or
  // `table` is not quietly handed this one instead.
  const overrides = useMemo(
    () => ({
      table: MarkdownTable,
      ...(linkFilePaths ? { span: FilePathSpan } : null),
      ...components,
    }),
    [linkFilePaths, components],
  );

  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      plugins={plugins}
      components={overrides}
      controls={CONTROLS}
      rehypePlugins={linkFilePaths ? REHYPE_PLUGINS_WITH_FILE_PATHS : REHYPE_PLUGINS}
      linkSafety={LINK_SAFETY}
      shikiTheme={shikiTheme}
      lineNumbers={false}
      className={cn(
        // `group/md` so the copy control can fade in on hover of the message —
        // Streamdown leaves it visible at rest otherwise.
        "group/md text-chat",

        // One size for every element in the message. Streamdown's prose styles
        // scale headings and small print off their own scale, so each is pinned
        // back to `text-chat`; `font-bold`/`italic` still apply, which is what
        // carries hierarchy now that size no longer does.
        "[&_h1]:text-chat [&_h2]:text-chat [&_h3]:text-chat [&_h4]:text-chat [&_h5]:text-chat [&_h6]:text-chat",
        "[&_p]:text-chat [&_li]:text-chat [&_blockquote]:text-chat [&_td]:text-chat [&_th]:text-chat",
        "[&_small]:text-chat [&_figcaption]:text-chat",
        // Headings keep their weight but lose the size jump, so the vertical
        // rhythm has to shrink or they read as isolated lines.
        "[&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:mt-3 [&_h3]:mb-1.5",

        // Code is the one thing that scales independently.
        "[&_code]:font-mono [&_code]:text-code [&_pre]:font-mono [&_pre_code]:text-code",
        // Streamdown only puts layout classes on a line span when `lineNumbers`
        // is on, and they carry the block display along with the gutter. Turning
        // numbering off leaves the spans inline, so the whole block collapses
        // onto one line — restore just the display, not the gutter.
        "[&_pre_code>span]:block",

        // Code: Streamdown nests a bordered card around another bordered box.
        // Strip the outer chrome and let the inner `pre` be the block.
        "[&_[data-streamdown=code-block]]:gap-0",
        "[&_[data-streamdown=code-block]]:bg-transparent [&_[data-streamdown=code-block]]:p-0",
        "[&_[data-streamdown=code-block-header]]:hidden",
        // The action bar already floats via `sticky` + `-mt-10`, which pulls it
        // up into the header's row. With the header hidden that space is gone
        // and the bar lands above the block, so the negative margin is dropped
        // and the bar overlays the first line instead. It's an unnamed wrapper,
        // hence the positional selector.
        "[&_[data-streamdown=code-block]>div:has([data-streamdown=code-block-actions])]:mt-2",
        "[&_[data-streamdown=code-block]>div:has([data-streamdown=code-block-actions])]:-mb-10",
        // The code block's border, radius, and scroll containment live in
        // App.css — they have to outrank Streamdown's own utilities, which these
        // arbitrary variants can't do at equal specificity.
        // Copy control: no chrome at rest, a subtle fill only under the cursor.
        "[&_[data-streamdown=code-block-actions]]:border-0 [&_[data-streamdown=code-block-actions]]:bg-transparent",
        "[&_[data-streamdown=code-block-actions]]:supports-[backdrop-filter]:bg-transparent",
        "[&_[data-streamdown=code-block-actions]]:p-0",
        "[&_[data-streamdown=code-block-copy-button]]:rounded-md [&_[data-streamdown=code-block-copy-button]]:p-1.5",
        "[&_[data-streamdown=code-block-copy-button]]:hover:bg-muted/60",
        "[&_[data-streamdown=code-block-copy-button]_svg]:size-3.5",
        // The copy control's reveal-on-hover lives in App.css too — it keys off
        // the code block itself, not this whole message.

        // Table: no enclosing box. The wrapper and scroll box are ours
        // ([MarkdownTable]) and carry no chrome of their own; only what
        // Streamdown still renders inside them needs clearing — the header's
        // fill, and cells with no structure of their own, so rows get the
        // rules instead.
        "[&_[data-streamdown=table-header]]:bg-transparent",
        "[&_th]:border-b [&_th]:border-border/60",
        "[&_tbody_tr]:border-b [&_tbody_tr]:border-border/30",
        // Each column is still capped, or one long-prose cell runs its whole
        // paragraph out on a single line and the reader scrolls a paragraph's
        // width to finish a sentence. The cap rides the block
        // `rehypeTableCells` puts inside every cell (see markdownPlugins for
        // why the `td` itself cannot carry it), spelled here so all table
        // styling reads in one place. Break-word rather than anywhere: only a
        // word wider than the whole cap breaks — a file path in a cell — so a
        // column can never collapse below its longest ordinary word.
        "[&_.dray-table-cell]:max-w-md [&_.dray-table-cell]:wrap-break-word",
        // The header cell's `whitespace-nowrap` has to lift, or a capped
        // header column overflows instead of wrapping.
        "[&_th]:whitespace-normal",
        // With cells now several lines tall, a middle-aligned short cell floats
        // opposite the middle of a paragraph beside it.
        "[&_td]:align-top",

        // Prose has the defect the table cells above had, one level out: a bare
        // path in a sentence has no break opportunity, so it runs past the
        // column and scrolls the whole transcript sideways. Streamdown already
        // carries `wrap-anywhere` on links, so only what it leaves plain is
        // named here — element by element rather than on the container, since
        // `overflow-wrap` inherits and a code block is meant to scroll its
        // lines rather than break them.
        "[&_p]:wrap-anywhere [&_li]:wrap-anywhere [&_blockquote]:wrap-anywhere",
        "[&_h1]:wrap-anywhere [&_h2]:wrap-anywhere [&_h3]:wrap-anywhere",
        "[&_h4]:wrap-anywhere [&_h5]:wrap-anywhere [&_h6]:wrap-anywhere",
        "[&_[data-streamdown=inline-code]]:wrap-anywhere",

        // Streamdown sets its own vertical rhythm; strip the leading and
        // trailing margin so a message sits flush in the transcript's gap.
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      {children}
    </Streamdown>
  );
}

/// Every `span` in the rendered markdown, passed through untouched unless
/// `rehypeFilePaths` marked it.
///
/// A pass-through rather than a narrow override, because `span` is an ordinary
/// element in markdown output and taking it over wholesale would swallow
/// whatever else put one there.
function FilePathSpan({ className, title, children, ...props }: React.ComponentProps<"span">) {
  // The path rides `title`, since a converted markdown link's text is its own
  // label rather than the path. Re-checked here rather than trusted: the class
  // is a plain attribute, and raw HTML in agent output can carry one.
  const classes = className?.split(" ") ?? [];
  if (classes.includes(FILE_PATH_CLASS) && title && isFilePath(title)) {
    return (
      <FileLink path={title} writtenAsLink={classes.includes(FILE_LINK_CLASS)}>
        {children}
      </FileLink>
    );
  }

  return (
    <span className={className} title={title} {...props}>
      {children}
    </span>
  );
}

// Every delta re-renders the transcript, so identical text must not re-parse.
export const Markdown = memo(MarkdownImpl);
