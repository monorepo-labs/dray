import { HARNESSES } from "@/lib/harnesses";

/// The agents Dray runs, as a logo row in the hero — the job a "trusted by"
/// row does: a reader scans the marks and knows in a second whether the
/// thing they use is here. No heading, since the sentence above already
/// says "every agent" and the row is what that means.
///
/// Mark and name together, since only one of the four has a mark anybody
/// recognises on its own. Not links: a logo row is read, and a click here
/// would leave the page for a vendor's site a screen above the download.
export function Harnesses({ className }: { className?: string }) {
  return (
    <ul className={`flex flex-wrap items-center gap-x-7 gap-y-3 ${className ?? ""}`}>
      {HARNESSES.map(({ name, Glyph }) => (
        <li key={name} className="flex items-center gap-2 text-base font-medium text-muted-foreground">
          <Glyph className="size-5 shrink-0" />
          {name}
        </li>
      ))}
    </ul>
  );
}
