import { cn } from "@/lib/utils";

/// A prompt on the right, an answer on the left, twice: the shape of the
/// transcript a read has not brought yet. Bottom-aligned, where a session opens.
const TURNS = [
  { prompt: "w-1/3", answer: ["w-full", "w-11/12", "w-2/3"] },
  { prompt: "w-1/2", answer: ["w-full", "w-5/6", "w-full", "w-1/2"] },
];

export default function TranscriptSkeleton() {
  return (
    <div aria-hidden className="h-full overflow-hidden">
      <div className="mx-auto flex h-full max-w-3xl flex-col justify-end gap-8 px-6 pt-6 pb-6">
        {TURNS.map((turn) => (
          <div key={turn.prompt} className="flex flex-col gap-4">
            <span className={cn("ml-auto h-9 animate-pulse rounded-2xl bg-muted-foreground/15", turn.prompt)} />
            <div className="flex flex-col gap-2.5">
              {turn.answer.map((width, i) => (
                <span key={i} className={cn("h-3 animate-pulse rounded bg-muted-foreground/10", width)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
