import type { Metadata } from "next";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/// Candidates for the hero's backdrop: the page's black at the top, one colour
/// at the foot, or for the pairs a first colour halfway and a second at the foot.
type Foot = { name: string; hex: string; via?: string };

const SINGLES: Foot[] = [
  { name: "Navy", hex: "#000C40" },
  { name: "Ink blue", hex: "#001A5C" },
  { name: "Royal", hex: "#0A2A8C" },
  { name: "Cobalt", hex: "#003B8F" },
  { name: "Azure night", hex: "#00305C" },
  { name: "Midnight indigo", hex: "#170B4A" },
  { name: "Violet", hex: "#2E1170" },
  { name: "Plum", hex: "#2A0A3A" },
  { name: "Magenta dusk", hex: "#3D0B3F" },
  { name: "Wine", hex: "#3A0A1E" },
  { name: "Deep teal", hex: "#002A33" },
  { name: "Petrol", hex: "#003D4D" },
  { name: "Forest", hex: "#03261A" },
  { name: "Moss", hex: "#1A2B0C" },
  { name: "Graphite blue", hex: "#111C2E" },
  { name: "Slate", hex: "#1E2836" },
  { name: "Ember", hex: "#3A1406" },
  { name: "Amber", hex: "#4A2A00" },
];

const PAIRS: Foot[] = [
  { name: "Navy into violet", via: "#000C40", hex: "#3B1E8C" },
  { name: "Navy into teal", via: "#000C40", hex: "#00525E" },
  { name: "Navy into magenta", via: "#000C40", hex: "#5A1458" },
  { name: "Navy into ember", via: "#000C40", hex: "#6A2410" },
  { name: "Navy into cobalt", via: "#000C40", hex: "#0047AB" },
  { name: "Indigo into rose", via: "#1A0F5C", hex: "#6B1E4A" },
  { name: "Indigo into amber", via: "#1A0F5C", hex: "#6B3A0A" },
  { name: "Indigo into cyan", via: "#1A0F5C", hex: "#005E7A" },
  { name: "Teal into navy", via: "#00333D", hex: "#0A1F7A" },
  { name: "Teal into violet", via: "#00333D", hex: "#3A1A80" },
  { name: "Teal into lime", via: "#00333D", hex: "#2E5A12" },
  { name: "Violet into orange", via: "#2E1170", hex: "#7A3410" },
  { name: "Violet into pink", via: "#2E1170", hex: "#7A1E5E" },
  { name: "Violet into azure", via: "#2E1170", hex: "#0B4F8C" },
  { name: "Plum into gold", via: "#3A0A3A", hex: "#6E4A08" },
  { name: "Wine into violet", via: "#3A0A1E", hex: "#3E1A7A" },
  { name: "Forest into blue", via: "#03261A", hex: "#0A3A7A" },
  { name: "Ember into plum", via: "#4A1606", hex: "#4A0E4A" },
];

export default function Gradients() {
  return (
    <div className="min-h-screen bg-[oklch(0.115_0_0)] px-4 py-12 sm:px-8">
      <h1 className="font-display text-2xl font-medium">Backdrop colours</h1>
      <Group title="One colour" line="Black at the top, the colour at the foot." foots={SINGLES} />
      <Group title="Two colours" line="Black at the top, the first colour halfway, the second at the foot." foots={PAIRS} />
    </div>
  );
}

function Group({ title, line, foots }: { title: string; line: string; foots: Foot[] }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{line}</p>
      <div className="mt-6 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {foots.map((f) => (
          <div
            key={`${f.via}${f.hex}`}
            className="relative flex h-96 flex-col items-center justify-center rounded-3xl px-6 text-center ring-1 ring-white/10"
            style={{
              backgroundImage: `linear-gradient(180deg, oklch(0.115 0 0), ${f.via ? `${f.via} 55%, ` : ""}${f.hex})`,
            }}
          >
            <p className="font-display text-3xl font-medium tracking-[-0.03em] sm:text-4xl">
              Every coding agent, one window.
            </p>
            <div className="mt-5 flex gap-3">
              <span className="inline-flex h-10 items-center rounded-[10px] border border-white/80 bg-gradient-to-b from-white to-[#e6e6eb] px-4 text-sm font-medium text-[#0b0b0f]">
                Download for macOS
              </span>
            </div>
            <p className="absolute bottom-5 left-6 text-sm">
              {f.name}{" "}
              <span className="font-mono text-muted-foreground">{f.via ? `${f.via} → ${f.hex}` : f.hex}</span>
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
