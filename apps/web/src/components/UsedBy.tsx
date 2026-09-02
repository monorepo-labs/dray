import { COUNTRIES } from "@/lib/countries";
import AE from "country-flag-icons/react/3x2/AE";
import BR from "country-flag-icons/react/3x2/BR";
import CA from "country-flag-icons/react/3x2/CA";
import CL from "country-flag-icons/react/3x2/CL";
import CN from "country-flag-icons/react/3x2/CN";
import DE from "country-flag-icons/react/3x2/DE";
import EG from "country-flag-icons/react/3x2/EG";
import ES from "country-flag-icons/react/3x2/ES";
import FR from "country-flag-icons/react/3x2/FR";
import GB from "country-flag-icons/react/3x2/GB";
import ID from "country-flag-icons/react/3x2/ID";
import IE from "country-flag-icons/react/3x2/IE";
import IN from "country-flag-icons/react/3x2/IN";
import JP from "country-flag-icons/react/3x2/JP";
import NG from "country-flag-icons/react/3x2/NG";
import NL from "country-flag-icons/react/3x2/NL";
import NP from "country-flag-icons/react/3x2/NP";
import PH from "country-flag-icons/react/3x2/PH";
import SG from "country-flag-icons/react/3x2/SG";
import TH from "country-flag-icons/react/3x2/TH";
import US from "country-flag-icons/react/3x2/US";
import VN from "country-flag-icons/react/3x2/VN";

/// The flags, keyed by the same ISO code [`COUNTRIES`] carries. Deep imports
/// rather than one named import off the package index: the index re-exports
/// every country there is, and pulling twenty-two out of it puts all 250 into
/// the module graph.
const FLAGS: Record<string, React.ComponentType<{ className?: string }>> = {
  AE, BR, CA, CL, CN, DE, EG, ES, FR, GB, ID, IE, IN, JP, NG, NL, NP, PH, SG, TH, US, VN,
};

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
            const Flag = FLAGS[c.code];
            const clone = i >= RUN.length;
            return (
              <span
                key={`${c.code}-${i}`}
                aria-hidden={clone || undefined}
                className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground"
              >
                {/* Rounded and hairlined, or a white flag on a dark page reads
                    as a hole rather than as a flag. */}
                <Flag className="h-3.5 w-auto rounded-[2px] ring-1 ring-white/15" />
                {c.name}
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}
