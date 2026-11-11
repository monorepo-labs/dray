import { cn } from "@/lib/utils";

/// Two turns in the transcript's own shape — a prompt bubble, a tool row, the
/// answer's lines on the chat text's rhythm — so the swap to the real thing
/// moves nothing much. Bottom-aligned where a session opens, the older turn
/// fading out above. One pulse on the whole, not one per bar: they breathe
/// together and it is a single opacity layer rather than a dozen repaints.
const TURNS = [
  { prompt: "w-2/5", tool: "w-28", answer: ["w-full", "w-11/12", "w-3/5"] },
  { prompt: "w-1/4", tool: "w-40", answer: ["w-full", "w-full", "w-5/6", "w-2/5"] },
];

/// `still` drops the pulse for a transcript nothing is loading: its server is
/// down and not trying, so breathing would promise an answer on the way.
export default function TranscriptSkeleton({ still = false }: { still?: boolean }) {
  return (
    <div aria-hidden className="h-full overflow-hidden">
      <div
        className={cn(
          "mx-auto flex h-full max-w-3xl flex-col justify-end gap-10 px-6 pt-6 pb-6 [mask-image:linear-gradient(to_bottom,transparent,black_45%)]",
          !still && "animate-pulse will-change-[opacity]",
        )}
      >
        {TURNS.map((turn) => (
          <div key={turn.prompt} className="flex flex-col gap-5">
            <div className={cn("ml-auto h-10 rounded-xl bg-card shadow-(--shadow-card)", turn.prompt)} />
            <div className="flex items-center gap-2">
              <span className="size-3.5 rounded-full bg-muted-foreground/15" />
              <span className={cn("h-2.5 rounded-full bg-muted-foreground/15", turn.tool)} />
            </div>
            <div className="flex flex-col gap-3.5">
              {turn.answer.map((width, i) => (
                <span key={i} className={cn("h-2.5 rounded-full bg-muted-foreground/10", width)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
