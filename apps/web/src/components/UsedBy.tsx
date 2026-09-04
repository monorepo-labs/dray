import { COUNTRIES } from "@/lib/countries";

/// ISO alpha-2 code → regional-indicator pair, which every platform font
/// draws as the flag. Windows Chrome draws the two letters instead; accepted,
/// since the name beside it carries the meaning either way.
function flag(code: string): string {
  return String.fromCodePoint(
    ...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

/// Where the run starts. A loop has no first item, so this is free to choose —
/// and it is worth choosing, because at rest the band's left edge is under the
/// fade and its middle is what a reader actually lands on. Three ahead of the
/// United States puts that flag there. Derived rather than written down, so
/// reordering [`COUNTRIES`] cannot leave it pointing at the wrong flag.
const START =
  (COUNTRIES.findIndex((c) => c.code === "US") - 3 + COUNTRIES.length) %
  COUNTRIES.length;
const RUN = [...COUNTRIES.slice(START), ...COUNTRIES.slice(0, START)];

/// The logo strip every landing page carries, with flags where the logos go.
///
/// Centred where the rest of the page is left-aligned, deliberately: the thing
/// being imitated is always centred, so it reads as a quotation of the format
/// rather than a section that forgot the grid.
///
/// The row slides for the same reason the testimonials do — twenty-two names
/// do not fit across a text column — and the mechanism is the same: the list is
/// drawn twice, the track slides half its own width, the copy is hidden from
/// assistive tech, and `prefers-reduced-motion` stops it in globals.css. It
/// does **not** pause on hover, since nothing here is clickable.
export function UsedBy({ className }: { className?: string }) {
  return (
    <section className={`text-center ${className ?? ""}`}>
      <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
        {/* The `+` is what keeps the line true between reads: the count is
            taken by hand and only ever goes up once this is live. */}
        Used by engineers in {COUNTRIES.length}+ countries
      </p>
      <div className="mt-5 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
        <div className="flex w-max animate-marquee gap-6">
          {[...RUN, ...RUN].map((c, i) => {
            const clone = i >= RUN.length;
            return (
              <span
                key={`${c.code}-${i}`}
                aria-hidden={clone || undefined}
                className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground"
              >
                <span aria-hidden>{flag(c.code)}</span>
                {c.name}
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}
