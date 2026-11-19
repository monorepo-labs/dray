// Takes on the sidebar's four icons — New Task, Issues, Search, New bot —
// drawn as our own SVGs, outline and filled, a few metaphors each. The whole
// app runs against a real `dray-serve` as servers.html runs it; a picker swaps
// the icons in with a stylesheet over the real rows, so no seam sits in `src/`.
//
//   open "/demo/sidebar-icons.html?localUrl=ws://127.0.0.1:<port>&local=<token>"
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import { useTheme } from "@/hooks/useTheme";

await import("./servers");

type Style = "outline" | "filled";
type Take = { name: string; outline: string; filled: string };

const O = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
// A solid shape with `cut` knocked out of it: white keeps, black removes.
const F = (shape: string, cut = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><mask id="m"><rect width="16" height="16" fill="#fff"/>${cut}</mask><g mask="url(#m)" fill="#000">${shape}</g></svg>`;
const cutStroke = (d: string, w = 1.6) =>
  `<path d="${d}" fill="none" stroke="#000" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

const BUBBLE =
  "M8 2.5c3.1 0 5.5 2.1 5.5 4.85S11.1 12.2 8 12.2c-.7 0-1.4-.1-2-.3L2.75 13.25l.9-2.6C2.9 9.75 2.5 8.6 2.5 7.35 2.5 4.6 4.9 2.5 8 2.5z";
const BLOB = "M7.2 2.75c3.1 0 5.3 1.9 5.3 4.8 0 3.1-2.4 5.7-5.5 5.7-2.7 0-4.5-2-4.5-4.8 0-3.1 1.9-5.7 4.7-5.7z";
const TICKET =
  "M2.5 5a1.25 1.25 0 0 1 1.25-1.25h8.5A1.25 1.25 0 0 1 13.5 5v1.4a1.6 1.6 0 0 0 0 3.2V11a1.25 1.25 0 0 1-1.25 1.25h-8.5A1.25 1.25 0 0 1 2.5 11V9.6a1.6 1.6 0 0 0 0-3.2z";
const TRAY =
  "M2.5 9.25l1.5-4.6A1.6 1.6 0 0 1 5.5 3.5h5a1.6 1.6 0 0 1 1.5 1.15l1.5 4.6v2.6a1.6 1.6 0 0 1-1.6 1.6H4.1a1.6 1.6 0 0 1-1.6-1.6z";
const STAR = "M8 2.25c.45 2.95 2.3 4.8 5.25 5.25-2.95.45-4.8 2.3-5.25 5.25-.45-2.95-2.3-4.8-5.25-5.25C5.7 7.05 7.55 5.2 8 2.25z";

const TASK: Take[] = [
  {
    name: "Plus",
    outline: O(`<path d="M8 3.25v9.5M3.25 8h9.5"/>`),
    filled: F(`<rect x="1.5" y="1.5" width="13" height="13" rx="4"/>`, cutStroke("M8 5v6M5 8h6", 1.8)),
  },
  {
    name: "Compose",
    outline: O(`<path d="M13 9v2.75A1.75 1.75 0 0 1 11.25 13.5h-6.5A1.75 1.75 0 0 1 3 11.75v-6.5A1.75 1.75 0 0 1 4.75 3.5H7.5"/><path d="M11.6 2.4l2 2-5.1 5.1-2.6.6.6-2.6z"/>`),
    filled: F(
      `<rect x="1.75" y="2.25" width="12" height="12" rx="3.5"/><path d="M12.4 1.1l2.5 2.5-1.4 1.4-2.5-2.5z"/>`,
      `<path d="M11.1 3.9l1 1-4.6 4.6-1.6.4.4-1.6z" fill="#000" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/>`,
    ),
  },
  {
    name: "Sparkle",
    outline: O(`<path d="${STAR}"/>`),
    filled: F(`<path d="${STAR}"/>`),
  },
];

const ISSUES: Take[] = [
  {
    name: "Linear",
    outline: O(`<circle cx="8" cy="8" r="5.75"/><path d="M8 5.1a2.9 2.9 0 0 1 0 5.8z" fill="#000" stroke="none"/>`),
    filled: F(`<circle cx="8" cy="8" r="6.75"/>`, `<circle cx="8" cy="8" r="4.6" fill="#000"/><path d="M8 5.6a2.4 2.4 0 0 1 0 4.8z" fill="#fff"/>`),
  },
  {
    name: "Ring",
    outline: O(`<circle cx="8" cy="8" r="5.75"/><circle cx="8" cy="8" r="1.5" fill="#000" stroke="none"/>`),
    filled: F(`<circle cx="8" cy="8" r="6.75"/>`, `<circle cx="8" cy="8" r="3" fill="#000"/><circle cx="8" cy="8" r="1.5" fill="#fff"/>`),
  },
  {
    name: "Ticket",
    outline: O(`<path d="${TICKET}"/><path d="M10 5.75v.5M10 7.75v.5M10 9.75v.5"/>`),
    filled: F(`<path d="${TICKET}"/>`, cutStroke("M10 5.75v.5M10 7.75v.5M10 9.75v.5", 1.4)),
  },
  {
    name: "Tray",
    outline: O(`<path d="${TRAY}"/><path d="M2.75 9.25h2.75l1 1.5h3l1-1.5h2.75"/>`),
    filled: F(`<path d="${TRAY}"/>`, cutStroke("M4.5 8.5h1.25l1 1.5h2.5l1-1.5h1.25", 1.4)),
  },
  {
    name: "Flag",
    outline: O(`<path d="M3.75 13.75V2.5"/><path d="M3.75 3h8l-1.75 2.9 1.75 2.85h-8"/>`),
    filled: F(`<path d="M3 2.5a.75.75 0 0 1 1.5 0v11.25a.75.75 0 0 1-1.5 0z"/><path d="M4.5 2.25h7.9a.6.6 0 0 1 .5.9l-1.6 2.75 1.6 2.75a.6.6 0 0 1-.5.9H4.5z"/>`),
  },
];

const SEARCH: Take[] = [
  {
    name: "Lens",
    outline: O(`<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25l3.25 3.25"/>`),
    filled: F(
      `<circle cx="7" cy="7" r="5.25"/><path d="M10 11.4l1.4-1.4 3.2 3.2a1 1 0 0 1-1.4 1.4z"/>`,
      `<circle cx="7" cy="7" r="2.9" fill="#000"/>`,
    ),
  },
  {
    name: "Glass",
    outline: O(`<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25l3.25 3.25"/><path d="M5 6.5a2 2 0 0 1 1.5-1.5"/>`),
    filled: F(
      `<circle cx="7" cy="7" r="5"/><path d="M10 11.4l1.4-1.4 3.2 3.2a1 1 0 0 1-1.4 1.4z"/>`,
      cutStroke("M4.75 6.6a2.4 2.4 0 0 1 1.85-1.85", 1.4),
    ),
  },
  {
    name: "Find in list",
    outline: O(`<path d="M2.5 3.75h9M2.5 7.25h4.5M2.5 10.75h3.5"/><circle cx="10.5" cy="10" r="2.5"/><path d="M12.4 11.9l1.6 1.6"/>`),
    filled: F(
      `<rect x="1.75" y="2.75" width="11" height="2" rx="1"/><rect x="1.75" y="6.25" width="6" height="2" rx="1"/><rect x="1.75" y="9.75" width="4.5" height="2" rx="1"/><circle cx="10.5" cy="10" r="3.25"/><path d="M12.2 12.9l1.1-1.1 1.6 1.6a.8.8 0 0 1-1.1 1.1z"/>`,
      `<circle cx="10.5" cy="10" r="1.5" fill="#000"/>`,
    ),
  },
];

const BOT: Take[] = [
  {
    name: "Bubble",
    outline: O(`<path d="${BUBBLE}"/><path d="M8 5.6v3.5M6.25 7.35h3.5"/>`),
    filled: F(`<path d="${BUBBLE}"/>`, cutStroke("M8 5.6v3.5M6.25 7.35h3.5", 1.6)),
  },
  {
    name: "Face",
    outline: O(`<rect x="2.25" y="2.75" width="11.5" height="10.5" rx="4.5"/><path d="M6.25 7v1.75M9.75 7v1.75"/>`),
    filled: F(`<rect x="1.75" y="2.25" width="12.5" height="11.5" rx="5"/>`, cutStroke("M6.25 6.9v2M9.75 6.9v2", 1.8)),
  },
  {
    name: "Blob +",
    outline: O(`<path d="${BLOB}"/><path d="M5.75 7.6v1.4M8.5 7.6v1.4M13.25 1.75v3M11.75 3.25h3"/>`),
    filled: F(
      `<path d="${BLOB}"/><path d="M12.5 1.75a.75.75 0 0 1 1.5 0V2.5h.75a.75.75 0 0 1 0 1.5H14v.75a.75.75 0 0 1-1.5 0V4h-.75a.75.75 0 0 1 0-1.5h.75z"/>`,
      cutStroke("M5.75 7.6v1.4M8.5 7.6v1.4", 1.6) + `<circle cx="13.25" cy="3.25" r="3" fill="#000"/><path d="M12.5 1.75a.75.75 0 0 1 1.5 0V2.5h.75a.75.75 0 0 1 0 1.5H14v.75a.75.75 0 0 1-1.5 0V4h-.75a.75.75 0 0 1 0-1.5h.75z" fill="#fff"/>`,
    ),
  },
];

// Search sits beside Drafts now, at that row's 12px; the strip's three are 16px.
const strip = (n: number) => `[data-rail-keep].pt-3 > :nth-child(${n})`;
const ROWS = [
  { label: "New Task", takes: TASK, at: strip(1), size: 16 },
  { label: "Issues", takes: ISSUES, at: strip(2), size: 16 },
  { label: "Search", takes: SEARCH, at: 'button[aria-label="Search"]', size: 12 },
  { label: "New bot", takes: BOT, at: strip(3), size: 16 },
];

const url = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

/// The stylesheet that puts the picked icons over the real rows: the row's own
/// SVG hidden, ours drawn in `currentColor` through a mask, at the row's size.
function css(style: Style | "original", picks: number[]) {
  if (style === "original") return "";
  return ROWS.map(({ takes, at, size }, i) => {
    const svg = takes[Math.min(picks[i], takes.length - 1)][style];
    return `${at} > svg { display: none; }
${at}::before { content: ""; flex: none; width: ${size}px; height: ${size}px;
  background-color: currentColor; -webkit-mask: ${url(svg)} center / contain no-repeat; mask: ${url(svg)} center / contain no-repeat; }`;
  }).join("\n");
}

/// Every take at 32px, filled over outline, for judging shape rather than fit.
function Sheet() {
  return (
    <div style={{ position: "fixed", top: 56, left: 260, zIndex: 100, background: "var(--surface-card)" }} className="flex flex-col gap-5 rounded-xl border border-border bg-popover p-5 text-ui shadow-lg">
      {ROWS.map((row) => (
        <div key={row.label} className="flex items-start gap-6">
          <span className="w-16 pt-2 text-muted-foreground">{row.label}</span>
          {row.takes.map((t) => (
            <div key={t.name} className="flex w-20 flex-col items-center gap-2">
              {(["filled", "outline"] as const).map((s) => (
                <span
                  key={s}
                  className="bg-foreground"
                  style={{ width: 32, height: 32, maskImage: url(t[s]), WebkitMaskImage: url(t[s]), maskSize: "contain", WebkitMaskSize: "contain" }}
                />
              ))}
              <span className="text-[11px] text-muted-foreground">{t.name}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Picker() {
  const [style, setStyle] = useState<Style | "original">("original");
  const [picks, setPicks] = useState([0, 0, 0, 0]);
  const [sheet, setSheet] = useState(false);
  const { resolvedMode, setMode } = useTheme();
  useEffect(() => setMode("light"), [setMode]);

  const chip = (on: boolean) =>
    `rounded-md px-2 py-0.5 text-[12px] ${on ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`;
  return (
    <>
      <style>{css(style, picks)}</style>
      {sheet && <Sheet />}
      <div className="fixed right-4 bottom-4 z-[100] flex w-[300px] flex-col gap-2 rounded-xl border border-border bg-popover p-3 text-ui shadow-lg">
        <div className="flex items-center gap-1">
          <span className="w-16 text-muted-foreground">Style</span>
          {(["filled", "outline", "original"] as const).map((s) => (
            <button key={s} className={chip(style === s)} onClick={() => setStyle(s)}>
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="w-16 text-muted-foreground">Set</span>
          {[0, 1, 2, 3].map((n) => (
            <button key={n} className={chip(picks.every((p, i) => p === Math.min(n, ROWS[i].takes.length - 1)))} onClick={() => setPicks([n, n, n, n])}>
              {"ABCD"[n]}
            </button>
          ))}
        </div>
        {ROWS.map((row, i) => (
          <div key={row.label} className="flex items-center gap-1">
            <span className="w-16 truncate text-muted-foreground">{row.label}</span>
            {row.takes.map((t, n) => (
              <button
                key={t.name}
                className={chip(picks[i] === n)}
                onClick={() => setPicks((p) => p.map((v, j) => (j === i ? n : v)))}
              >
                {t.name}
              </button>
            ))}
          </div>
        ))}
        <div className="flex items-center gap-1">
          <span className="w-16 text-muted-foreground">Mode</span>
          {(["light", "dark"] as const).map((m) => (
            <button key={m} className={chip(resolvedMode === m)} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
          <button className={`ml-auto ${chip(sheet)}`} onClick={() => setSheet((o) => !o)}>
            all icons
          </button>
        </div>
      </div>
    </>
  );
}

const host = document.createElement("div");
document.body.append(host);
ReactDOM.createRoot(host).render(<Picker />);
