import type { ReactNode } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

/// Code, bold and links — the only marks a changelog line uses. Not
/// `Markdown`: a Streamdown per item is a few hundred of them on one tab.
export function changelogInline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`"))
      return (
        <code key={i} className="rounded bg-muted px-1 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    if (part.startsWith("**") && part.endsWith("**"))
      return (
        <strong key={i} className="font-medium text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link)
      return (
        <button
          key={i}
          type="button"
          onClick={() => void openUrl(link[2])}
          className="cursor-pointer text-foreground underline underline-offset-4"
        >
          {link[1]}
        </button>
      );
    return part;
  });
}

/// Markdown marks dropped, for a line that cannot carry them.
export const changelogPlain = (text: string) =>
  text.replace(/\*\*|`/g, "").replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1");
