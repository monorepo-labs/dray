import type { CSSProperties, ReactNode } from "react";
import m from "./motion.module.css";
import { PlayWhenVisible } from "./PlayWhenVisible";
import { Section, Title } from "./Section";

type Key = "root" | "upload" | "retry" | "progress" | "docs" | "reviewApi" | "reviewDocs";
type Child = Exclude<Key, "root">;

/// Inline timing for a `motion.module.css` class, as fractions of one loop;
/// `ramp` steepens an `appear` past its default 1/25 of a loop.
const at = (s: number, l = 0.06, ramp?: number) => ({ "--s": s, "--l": l, "--ramp": ramp }) as CSSProperties;

/// Paper's tile texture: ten 2px bars, 6px apart, across a 60px tile.
const stripes = (x: number, y: number, h = 60) =>
  Array.from({ length: 10 }, (_, i) => `M${x + i * 6} ${y}h2v${h}h-2z`).join("");

const CLAUDE =
  "M-0.282 14.965l6.398-3.589 0.106-0.314-0.106-0.173h-0.314l-1.07-0.066-3.656-0.098-3.17-0.133-3.072-0.164-0.774-0.165-0.725-0.955 0.075-0.477 0.651-0.437 0.931 0.083 2.059 0.14 3.087 0.214 2.24 0.132 3.318 0.346h0.527l0.075-0.215-0.182-0.131-0.14-0.132L2.782 6.665l-3.459-2.289-1.811-1.318-0.98-0.667-0.495-0.626-0.213-1.367 0.889-0.979 1.193 0.822 0.306 0.824 1.211 0.931 2.584 2 3.376 2.487 0.495 0.411 0.196-0.14 0.025-0.099-0.222-0.37-1.837-3.319-1.959-3.376-0.873-1.4-0.23-0.84c-0.082-0.346-0.14-0.634-0.14-0.988L1.852-6.494 2.412-6.675l1.35 0.181 0.569 0.494 0.839 1.92 1.359 3.021 2.107 4.11 0.618 1.219 0.329 1.128 0.124 0.346h0.214v-0.198l0.173-2.313 0.321-2.841 0.314-3.657 0.106-1.03 0.51-1.234 1.014-0.667 0.79 0.378 0.651 0.931-0.906 0.6-0.387 2.512-0.757 3.936-0.495 2.635h0.289l0.329-0.329 1.334-1.77 2.239-2.8 0.988-1.111 1.153-1.227 0.74-0.584h1.399l1.03 1.531-0.461 1.581-1.442 1.828-1.194 1.548-1.713 2.306-1.07 1.844 0.099 0.148 0.255-0.025 3.869-0.823 2.091-0.379 2.496-0.428 1.128 0.527 1.234 0.536-0.444 1.094-2.667 0.659-3.129 0.627-4.661 1.103-0.576 0.04 0.659 0.083 2.1 0.197 0.897 0.05h2.199l4.093 0.305 1.07 0.707 0.643 0.866-1.071 0.659-1.647 0.84-2.223-0.528-5.187-1.235-1.778-0.444h-0.248v0.148l1.482 1.45 2.717 2.453 3.4 3.162 0.173 0.782-0.436 0.618-0.461-0.067-2.99-2.247-1.152-1.013-2.611-2.198h-0.173v0.23l0.601 0.882 3.179 4.775 0.165 1.466-0.231 0.478-0.824 0.287-0.905-0.164-1.86-2.611L12.828 17.682l-1.548-2.636-0.189 0.108-0.915 9.839-0.427 0.502-0.989 0.378-0.824-0.625-0.435-1.013 0.436-2.001 0.527-2.611 0.428-2.074 0.387-2.577 0.231-0.857-0.017-0.058-0.19 0.025-1.943 2.668-2.957 3.994-2.338 2.504-0.56 0.222-0.971-0.502 0.091-0.898 0.543-0.798 3.237-4.118 1.951-2.552 1.26-1.475-0.009-0.214h-0.073l-8.596 5.582-1.531 0.198-0.659-0.618 0.083-1.013 0.313-0.329 2.585-1.778Z";

const OPENAI =
  "M23.995 6.55a8.379 8.379 0 0 0-0.722-6.876 8.465 8.465 0 0 0-9.114-4.06A8.491 8.491 0 0 0-0.226-1.345a8.379 8.379 0 0 0-5.597 4.06 8.465 8.465 0 0 0 1.039 9.936 8.372 8.372 0 0 0 0.716 6.875 8.472 8.472 0 0 0 9.121 4.06A8.379 8.379 0 0 0 11.364 26.4a8.479 8.479 0 0 0 8.081-5.888 8.384 8.384 90 0 0 5.597-4.06 8.479 8.479 0 0 0-1.046-9.902z m-12.631 17.651a6.267 6.267 0 0 1-4.026-1.457l0.199-0.113 6.688-3.861a1.113 1.113 0 0 0 0.551-0.954v-9.432l2.828 1.637a0.1 0.1 0 0 1 0.052 0.073v7.816a6.305 6.305 90 0 1-6.293 6.291z m-13.525-5.775a6.26 6.26 0 0 1-0.749-4.22l0.199 0.119 6.696 3.862a1.08 1.08 0 0 0 1.093 0l8.181-4.717v3.265a1.125 0.112 0 0 1-0.465 0.087L6.436 20.73a6.298 6.298 90 0 1-8.597-2.304zM-3.922 3.855a6.279 6.279 0 0 1 3.311-2.762V9.04a1.073 1.073 0 0 0 0.542 0.948l8.141 4.696-2.828 1.636a1.06 0.107 0 0 1-0.1 0l-6.762-3.901A6.305 6.305 90 0 1-3.922 3.821z m23.234 5.398L11.146 4.51 13.967 2.88a1.06 0.107 0 0 1 0.099 0l6.762 3.908a6.291 6.291 90 0 1-0.947 11.345v-7.947a1.106 1.106 0 0 0-0.569-0.934z m2.816-4.232l-0.199-0.12-6.684-3.894a1.087 1.086 90 0 0-1.099 0L5.973 5.722V2.456a0.927 0.093 0 0 1 0.04-0.086l6.762-3.902a6.298 6.298 90 0 1 9.352 6.524zM4.429 10.809l-2.828-1.63a1.125 0.112 0 0 1-0.053-0.079V1.304a6.298 6.298 90 0 1 10.326-4.836l-0.199 0.114L4.986 0.443a1.113 1.113 0 0 0-0.55 0.953z m1.537-3.311l3.643-2.1 3.65 2.1v4.198l-3.636 2.1-3.65-2.1Z";

const ICONS: Record<string, { viewBox: string; opacity?: number; body: ReactNode }> = {
  claude: { viewBox: "-7.2 -7.2 33.6 33.6", body: <path d={CLAUDE} fill="#D97757" /> },
  openai: { viewBox: "-7.2 -7.2 33.6 33.6", opacity: 0.8, body: <path d={OPENAI} fill="#FFFFFF" className="light:fill-[#0A0A0A]" /> },
  grok: {
    viewBox: "-7.2 -7.2 33.6 33.6",
    opacity: 0.8,
    body: (
      <path
        fillRule="evenodd"
        d="M5.778 14.206l11.169-8.255c0.548-0.406 1.33-0.248 1.592 0.38 1.372 3.316 0.759 7.301-1.974 10.036-2.732 2.735-6.534 3.335-10.009 1.969l-3.795 1.76c5.444 3.726 12.056 2.804 16.186-1.335 3.278-3.281 4.293-7.754 3.344-11.788l0.008 0.011c-1.376-5.925 0.339-8.293 3.85-13.136 0.084-0.115 0.168-0.229 0.251-0.348l-4.622 4.627v-0.014L5.773 14.209M3.472 16.213c-3.909-3.738-3.234-9.522 0.099-12.859 2.466-2.468 6.506-3.476 10.033-1.995l3.787-1.75a10.931 10.931 90 0 0-2.561-1.4A12.565 12.565 0 0 0 1.177 0.962c-3.546 3.551-4.662 9.011-2.747 13.669 1.431 3.482-0.914 5.945-3.276 8.432-0.838 0.882-1.678 1.762-2.354 2.695l10.668-9.541"
        fill="#FFFFFF"
        className="light:fill-[#0A0A0A]"
      />
    ),
  },
  kimi: {
    viewBox: "-240 -240 1120 1120",
    opacity: 0.95,
    body: (
      <>
        <rect width="1155" height="1155" rx="180" x="-257.5" y="-257.5" fill="#FFFFFF" />
        <path
          fillRule="evenodd"
          d="M-18.863-18.863H489.438V320H320V489.438H150.576V658.877H-18.863ZM150.576 150.576V320H320V150.576Z"
          fill="#000000"
        />
        <path d="M489.438 320H658.877V658.877H489.438Z" fill="#000000" />
      </>
    ),
  },
  fx: {
    viewBox: "119.483 0 218.206 218.4",
    opacity: 0.8,
    body: (
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M219.779 0.005C227.185 0.005 235.865 1.993 240.975 4.303L243.859 5.619 236.845 26.087 233.485 24.855C229.593 23.413 225.449 22.125 220.619 22.125 215.705 22.125 212.639 23.189 210.245 25.653 207.655 28.327 205.415 33.101 203.455 41.669L203.455 41.669 203.455 41.669 201.929 48.795H225.071L251.335 48.935 251.699 48.935 251.909 49.243 277.123 86.287 302.169 48.935H335.951L295.085 107.441 337.673 167.655H305.795L305.585 167.375 224.329 56.677 221.823 69.165H197.631L174.699 178.099C172.235 189.999 168.399 199.981 162.225 207.023 155.911 214.219 147.413 218.055 136.409 218.055 130.585 218.055 125.783 217.159 121.807 215.759L119.469 214.933V192.057L120.393 192.365 124.075 193.597C127.785 194.829 130.907 195.725 134.729 195.725 136.675 195.725 138.313 195.347 139.755 194.577 141.197 193.807 142.485 192.645 143.661 191.021 146.153 187.591 148.141 182.187 149.793 174.543L171.997 69.165H152.551L155.197 55.221 155.589 55.095 176.281 48.263 178.143 40.101C181.461 25.499 186.011 15.321 192.927 8.853 199.969 2.259 208.915 0.005 219.779 0.005ZM270.319 138.717L250.831 168.355H215.089L252.133 114.833 270.319 138.717Z"
        fill="#FFFFFF"
        className="light:fill-[#0A0A0A]"
      />
    ),
  },
};

// Light greys for the agents' tiles, with their marks drawn dark to suit; the
// root keeps its blue.
const LIGHT_TILE: Record<string, string> = {
  "#2E2E2E": "light:fill-[#E4E4E4]",
  "#1F1F1F": "light:fill-[#D9D9D9]",
};

type Node = { tile: string; icon: keyof typeof ICONS; model: string; task: string };
type Point = [x: number, y: number];

const NODES: Record<Key, Node> = {
  root: { tile: "#1612F8", icon: "claude", model: "Opus 5.5", task: "Ship file uploads" },
  upload: { tile: "#2E2E2E", icon: "openai", model: "Sol 6.1", task: "Upload API" },
  retry: { tile: "#2E2E2E", icon: "claude", model: "Opus 5.5", task: "Retry uploads" },
  progress: { tile: "#2E2E2E", icon: "grok", model: "Grok 4.7", task: "Progress UI" },
  docs: { tile: "#2E2E2E", icon: "kimi", model: "Kimi K3", task: "CLI docs" },
  reviewApi: { tile: "#1F1F1F", icon: "fx", model: "Sol 6.1", task: "Review upload API" },
  reviewDocs: { tile: "#1F1F1F", icon: "openai", model: "Sol 6.1", task: "Review CLI docs" },
};
const PARENT: Record<Child, Key> = {
  upload: "root",
  retry: "root",
  progress: "root",
  docs: "root",
  reviewApi: "upload",
  reviewDocs: "docs",
};
const CHILDREN = Object.keys(PARENT) as Child[];

/// Where each session sits and how a line runs between two of them; the
/// timeline below is shared by every layout.
type Layout = {
  viewBox: string;
  className: string;
  at: Record<Key, Point>;
  /// Parent to child, or child back to parent when `up`.
  edge: (parent: Point, child: Point, up?: boolean) => string;
  mesh?: string;
};

/// Paper's frame minus the 40px the graph's svg sits down: root on the left,
/// the children in a column, the reviews on the right.
const WIDE: Layout = {
  viewBox: "240 320 960 420",
  className: "w-full max-sm:hidden",
  at: {
    root: [240, 500],
    upload: [600, 320],
    retry: [600, 440],
    progress: [600, 560],
    docs: [600, 680],
    reviewApi: [960, 380],
    reviewDocs: [960, 620],
  },
  edge: ([px, py], [cx, cy], up) => {
    const a = `${px + 240} ${py + 30}`;
    const b = `${cx} ${cy + 30}`;
    return up ? `M${b}L${a}` : `M${a}L${b}`;
  },
  mesh: "M480 530L960 410M480 530L960 650M840 350L960 650M840 470L960 410M840 470L960 650M840 590L960 410M840 590L960 650M840 710L960 410",
};

/// Phones: a tree read top down, each review indented under its parent. No
/// mesh, which here only crossed the tree's own lines.
const TALL: Layout = {
  viewBox: "0 0 340 564",
  className: "w-full max-w-[360px] sm:hidden",
  at: {
    root: [0, 0],
    upload: [50, 84],
    reviewApi: [100, 168],
    retry: [50, 252],
    progress: [50, 336],
    docs: [50, 420],
    reviewDocs: [100, 504],
  },
  // Down from under the parent's tile, then across into the child's.
  edge: ([px, py], [cx, cy], up) =>
    up ? `M${cx} ${cy + 30}H${px + 30}V${py + 60}` : `M${px + 30} ${py + 60}V${cy + 30}H${cx}`,
};

// Every timeline finishes by 0.9 of its loop, the still reduced motion shows.
// The spawn is over in under a second (0.066 of 14s), since readers scroll
// past fast; the pulses keep their unhurried pace.
const SPAWN: Record<Child, number> = {
  upload: 0.012,
  retry: 0.02,
  progress: 0.028,
  docs: 0.036,
  reviewApi: 0.048,
  reviewDocs: 0.056,
};
const SPAWN_RAMP = 100;
const TRAVEL = 0.05;

// Work handed down and answers coming back: root to children, children to
// their reviews, reviews back, children back to root, then round again.
const PULSES: { child: Child; up?: boolean; at: number }[] = [
  { child: "upload", at: 0.2 },
  { child: "retry", at: 0.22 },
  { child: "progress", at: 0.24 },
  { child: "docs", at: 0.26 },
  { child: "reviewApi", at: 0.34 },
  { child: "reviewDocs", at: 0.37 },
  { child: "reviewApi", up: true, at: 0.45 },
  { child: "reviewDocs", up: true, at: 0.48 },
  { child: "retry", up: true, at: 0.53 },
  { child: "progress", up: true, at: 0.56 },
  { child: "upload", up: true, at: 0.6 },
  { child: "docs", up: true, at: 0.63 },
  { child: "retry", at: 0.7 },
  { child: "upload", at: 0.73 },
  { child: "reviewApi", at: 0.79 },
  { child: "retry", up: true, at: 0.82 },
];

function Session({ n, at: [x, y], className, style }: { n: Node; at: Point; className?: string; style?: CSSProperties }) {
  const icon = ICONS[n.icon];
  return (
    <g className={className} style={style}>
      <rect x={x + 60} y={y} width="180" height="60" fill="#161616" className="light:fill-white" />
      <rect x={x} y={y} width="60" height="60" fill={n.tile} className={LIGHT_TILE[n.tile]} />
      <path d={stripes(x, y)} fill="#0000008C" className={LIGHT_TILE[n.tile] && "light:fill-[#0000000F]"} />
      <svg x={x + 16} y={y + 16} width="28" height="28" viewBox={icon.viewBox} opacity={icon.opacity}>
        {icon.body}
      </svg>
      <text x={x + 72} y={y + 18} dominantBaseline="central" fontSize="11" letterSpacing="-0.04em" fill="#8A8A8A" className="font-mono">
        {n.model}
      </text>
      <text x={x + 72} y={y + 38} dominantBaseline="central" fontSize="13" letterSpacing="-0.04em" fill="#FFFFFF" className="font-mono light:fill-[#0A0A0A]">
        {n.task}
      </text>
    </g>
  );
}

/// The session graph, one drawing in its layout's own coordinates so labels
/// can't drift from their boxes as it scales.
function Graph({ layout: { viewBox, className, at: pos, edge, mesh } }: { layout: Layout }) {
  const line = (child: Child, up?: boolean) => edge(pos[PARENT[child]], pos[child], up);
  const [rx, ry] = pos.retry;
  return (
    <svg
      viewBox={viewBox}
      className={`h-auto overflow-visible ${className} ${m.timeline}`}
      style={{ "--dur": "14s" } as CSSProperties}
      role="img"
      aria-label="A session graph. Opus 5.5 on “Ship file uploads” starts four sessions: Sol 6.1 on “Upload API”, Opus 5.5 on “Retry uploads”, Grok 4.7 on “Progress UI” and Kimi K3 on “CLI docs”. Two Sol 6.1 sessions then review the upload API and the CLI docs."
    >
      <g className={m.fadeOut} style={at(0.94)}>
        {mesh && <path d={mesh} fill="none" stroke="#FFFFFF1F" className={`${m.appear} light:stroke-[#0000001A]`} style={at(0.09)} />}
        {CHILDREN.map((k) => (
          <path
            key={k}
            d={line(k)}
            pathLength={1}
            fill="none"
            // Opaque rather than translucent white: the tree's lines share a trunk, which would brighten where they overlap.
            stroke="#B3B3B3"
            strokeWidth="1.5"
            className={`${m.draw} light:stroke-[#C4C4C4]`}
            style={at(SPAWN[k] - 0.01, 0.01)}
          />
        ))}
        <path
          d={`M${rx + 30} ${ry + 60}V${pos.progress[1]}`}
          pathLength={1}
          fill="none"
          stroke="#FFFFFF6B"
          strokeWidth="1.5"
          className={`${m.draw} light:stroke-[#C4C4C4]`}
          style={at(SPAWN.progress - 0.01, 0.01)}
        />
        {PULSES.map((p) => (
          <path
            key={`${p.child}-${p.at}`}
            d={line(p.child, p.up)}
            pathLength={1}
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="2.5"
            strokeLinecap="round"
            className={`${m.pulse} light:stroke-[#1612F8]`}
            style={at(p.at, TRAVEL)}
          />
        ))}
        {CHILDREN.map((k) => (
          <Session key={k} n={NODES[k]} at={pos[k]} className={m.appear} style={at(SPAWN[k], undefined, SPAWN_RAMP)} />
        ))}
      </g>
      <Session n={NODES.root} at={pos.root} />

      {/* The receiving session's tile flashes as a pulse lands. */}
      {PULSES.map((p) => {
        const [x, y] = pos[p.up ? PARENT[p.child] : p.child];
        return (
          <rect
            key={`${p.child}-${p.at}`}
            x={x}
            y={y}
            width="60"
            height="60"
            fill="#FFFFFF"
            fillOpacity="0.3"
            className={m.blip}
            style={at(p.at + TRAVEL, 0.04)}
          />
        );
      })}
    </svg>
  );
}

const COL0 = ["#141414", "#141414", "#262626", "#262626", "#3D3D3D", "#6B6B6B", "#6B6B6B", "#A3A3A3", "#1612F8", "#1612F8", "#1612F8", "#F2F2F2", "#F2F2F2", "#F2F2F2"];
const COL1 = ["#262626", "#6B6B6B", "#1612F8", "#F2F2F2"];
// The grey ramp turned over for the light page, so the column still runs from
// the page's own shade into the blue and out the far side.
const LIGHT: Record<string, string> = {
  "#141414": "light:fill-[#F5F5F5]",
  "#262626": "light:fill-[#E6E6E6]",
  "#3D3D3D": "light:fill-[#CFCFCF]",
  "#6B6B6B": "light:fill-[#9A9A9A]",
  "#A3A3A3": "light:fill-[#5C5C5C]",
  "#F2F2F2": "light:fill-[#141414]",
};

/// The pixel column on the window's left edge. Off below xl, where the
/// content column would run into it.
function Tiles() {
  const tiles = [...COL0.map((fill, i) => ({ x: 0, y: 40 + i * 60, fill })), ...COL1.map((fill, i) => ({ x: 60, y: 640 + i * 60, fill }))];
  return (
    <svg
      viewBox="0 0 120 880"
      width="120"
      height="880"
      aria-hidden="true"
      // The inner column is centred, so its left edge sits half the spare width in from the window's.
      className="pointer-events-none absolute -bottom-[100px] left-[calc(480px-50vw)] hidden xl:block"
    >
      <rect width="60" height="40" fill="#141414" className={LIGHT["#141414"]} />
      {tiles.map((t) => (
        <rect key={`${t.x}-${t.y}`} x={t.x} y={t.y} width="60" height="60" fill={t.fill} className={LIGHT[t.fill]} />
      ))}
      <path d={stripes(0, 0, 40) + tiles.map((t) => stripes(t.x, t.y)).join("")} fill="#0000008C" className="light:fill-[#00000024]" />
    </svg>
  );
}

const REST =
  "Plan with GPT Sol, then hand the build to Opus. Steer sessions from one chat, or jump into any of them directly. Spot another issue mid-task? Ask that session to start a new one.";

/// "Orchestrate agents": the headline over a session graph that spawns, then
/// passes work back and forth. Phones get the graph as a tree and the
/// headline's grey rest under it.
export function Orchestrate() {
  return (
    <Section id="orchestrate" className="pt-20 pb-[100px] light:bg-[#F4F4F2]">
      <Tiles />
      <Title lead="Orchestrate agents however you work.">
        <span className="max-sm:hidden">{REST}</span>
      </Title>
      <PlayWhenVisible className="mt-10 sm:mt-20">
        <Graph layout={WIDE} />
        <Graph layout={TALL} />
      </PlayWhenVisible>
      <p className="mt-10 font-inter text-[22px] leading-[28px] font-light tracking-[-0.02em] text-balance text-[#7C7C7C] sm:hidden light:text-[#8A8A8A]">
        {REST}
      </p>
    </Section>
  );
}
