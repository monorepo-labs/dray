import { useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

import GitHubIcon from "@/components/GitHubIcon";
import { cn } from "@/lib/utils";

/// Which repository a bot's `#` menu reads, in that menu's header.
///
/// Not the issues page's Radix `RepoMenu`, though it looks like one: a Radix
/// menu takes focus when it opens, and the `#` menu lives only while the
/// composer's editor holds it. Handing focus back after it closed still lost
/// the next keystroke's caret, so every button here keeps focus where it is,
/// the rule `PickerMenu`'s header states.
export default function MentionRepoPicker({
  repo,
  repos,
  onPick,
}: {
  repo: string | null;
  repos: readonly string[];
  onPick: (repo: string) => void;
}) {
  /// Where the list opens, read off the chip on open. Portalled, since the
  /// picker's frame clips to its rounded corners.
  const [at, setAt] = useState<CSSProperties | null>(null);
  const chip = useRef<HTMLButtonElement>(null);
  if (!repos.length) return null;

  return (
    <>
      <button
        ref={chip}
        type="button"
        aria-expanded={at !== null}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const box = chip.current?.getBoundingClientRect();
          setAt(at || !box ? null : placeMenu(box));
        }}
        className={cn(
          "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-ui transition-colors",
          repo ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <GitHubIcon className="size-3.5" />
        <span className="max-w-40 truncate">{repo ? repo.slice(repo.indexOf("/") + 1) : "Choose a repository"}</span>
        <ChevronDown className="size-3 opacity-60" />
      </button>

      {at &&
        createPortal(
          <div
            role="menu"
            aria-label="Repository"
            style={at}
            className="fixed z-50 w-64 overflow-y-auto overscroll-contain rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-xl"
          >
            <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">Repository</div>
            {repos.map((option) => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={option === repo}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(option);
                  setAt(null);
                }}
                className="relative flex w-full items-center rounded-md py-1 pr-8 pl-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <span className="min-w-0 break-words">{option}</span>
                {option === repo && <Check className="absolute right-2 size-4" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/// Opens under the chip, or over it where more room is above, and scrolls
/// within whichever space it gets, so a long list never runs off the window.
function placeMenu(box: DOMRect): CSSProperties {
  const gap = 4;
  const edge = 8;
  const below = window.innerHeight - box.bottom - gap - edge;
  const above = box.top - gap - edge;
  return below >= Math.min(above, 240)
    ? { left: box.left, top: box.bottom + gap, maxHeight: below }
    : { left: box.left, bottom: window.innerHeight - box.top + gap, maxHeight: above };
}
