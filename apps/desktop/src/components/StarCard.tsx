import { useEffect, useState } from "react";
import { StarIcon } from "@heroicons/react/16/solid";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/button";
import { closeStarPrompt } from "@/hooks/useStarPrompt";
import { invoke } from "@/lib/transport";

const REPO_URL = "https://github.com/monorepo-labs/dray";

/// How long the thanks stays before the card goes.
const THANKS_MS = 1800;

/// Asks for a star on GitHub after a merge made in the app, in the corner
/// What's New uses and in its frame. Star stars as the reader's `gh` login in
/// one click; where that fails it opens the repo page, so the click still
/// lands somewhere a star is one more click away.
export default function StarCard() {
  const [phase, setPhase] = useState<"ask" | "starring" | "thanks">("ask");

  useEffect(() => {
    if (phase !== "thanks") return;
    const id = setTimeout(closeStarPrompt, THANKS_MS);
    return () => clearTimeout(id);
  }, [phase]);

  const star = async () => {
    setPhase("starring");
    try {
      await invoke("star_dray");
      setPhase("thanks");
    } catch {
      void openUrl(REPO_URL).catch(() => {});
      closeStarPrompt();
    }
  };

  return (
    <div
      role="region"
      aria-label="Star Dray on GitHub"
      className="fixed bottom-3 left-3 z-50 flex w-64 flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-(--shadow-ring) backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2"
    >
      {phase === "thanks" ? (
        <span className="flex items-center gap-1.5 p-3 text-ui font-medium text-foreground">
          <StarIcon className="size-3.5 text-accent-command" aria-hidden />
          Thanks for the star!
        </span>
      ) : (
        <>
          <span className="flex gap-1.5 px-3 pt-2.5 text-ui font-medium text-foreground">
            <span aria-hidden className="flex h-[1lh] shrink-0 items-center">
              <StarIcon className="size-3.5 text-accent-command" />
            </span>
            Liking Dray so far? A star would help us.
          </span>
          <div className="grid grid-cols-2 gap-1.5 p-2.5">
            <Button variant="ghost" size="sm" onClick={closeStarPrompt}>
              Not now
            </Button>
            <Button size="sm" disabled={phase === "starring"} onClick={() => void star()}>
              {phase === "starring" ? "Starring…" : "Star"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
