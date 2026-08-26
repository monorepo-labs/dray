import { memo, useMemo } from "react";
import { Streamdown, type LinkSafetyConfig, type ThemeInput } from "streamdown";

import LinkDialog from "@/components/chat/LinkDialog";
import { useCodeTheme } from "@/hooks/useCodeTheme";
import { createSharedCodePlugin } from "@/lib/codePlugin";
import type { CodeThemePair } from "@/lib/codeTheme";
import { cn } from "@/lib/utils";

type MarkdownProps = {
  children: string;
  /// True while deltas are still arriving, so incomplete blocks render as
  /// prose instead of flickering through half-parsed markdown.
  streaming?: boolean;
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

// Copy is the only control worth keeping. Table actions and code download are
// off entirely rather than hidden with CSS, so they can't be tabbed to either.
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
function MarkdownImpl({ children, streaming = false, className }: MarkdownProps) {
  // Shiki takes a [light, dark] pair and picks by the `.dark` class our theme
  // already sets, so this needs no mode of its own — only the user's pick.
  const { pair } = useCodeTheme();
  const shikiTheme = useMemo(
    (): [ThemeInput, ThemeInput] => [pair.light as ThemeInput, pair.dark as ThemeInput],
    [pair.light, pair.dark],
  );
  const plugins = useMemo(() => ({ code: codePlugin(pair) }), [pair]);

  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      plugins={plugins}
      controls={CONTROLS}
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

        // Table: no enclosing box. The outline lives on an unnamed div between
        // the wrapper and the table, so all three layers have to be cleared —
        // including that div's own `bg-background`, which cost nothing to leave
        // while the page was that exact colour and became a slab behind every
        // table the moment the page was glass.
        "[&_[data-streamdown=table-wrapper]]:border-0 [&_[data-streamdown=table-wrapper]]:bg-transparent [&_[data-streamdown=table-wrapper]]:p-0",
        "[&_[data-streamdown=table-wrapper]]:rounded-none",
        "[&_[data-streamdown=table-wrapper]>div]:rounded-none [&_[data-streamdown=table-wrapper]>div]:border-0",
        "[&_[data-streamdown=table-wrapper]>div]:bg-transparent",
        "[&_[data-streamdown=table-header]]:bg-transparent",
        "[&_table]:rounded-none [&_table]:border-0",
        // Cells carry no rules of their own, so removing the outline would leave
        // the table with no structure at all — put it back on the rows.
        "[&_th]:border-b [&_th]:border-border/60",
        "[&_tbody_tr]:border-b [&_tbody_tr]:border-border/30",
        // A cell that cannot break sets the table's width: one file path in a
        // bot's summary table pushed every other column out of the PR panel and
        // left the reader scrolling sideways to read a sentence. Anywhere rather
        // than break-word, because only `anywhere` shrinks the cell's min-content
        // width, which is what the auto layout measures. The wrapper keeps its
        // own scroll for a table that is genuinely wide.
        // The header cell needs its `whitespace-nowrap` lifted first, or the
        // wrap rule is dead on it — nowrap outranks overflow-wrap.
        "[&_th]:whitespace-normal [&_th]:wrap-anywhere [&_td]:wrap-anywhere",
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

// Every delta re-renders the transcript, so identical text must not re-parse.
export const Markdown = memo(MarkdownImpl);
