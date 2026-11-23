import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";

import AgentIcon from "@/components/AgentIcon";
import type { Harness } from "@/types/events";
import { cn } from "@/lib/utils";
import "../App.css";

/// Illustrations for What's New highlights, drawn in code in the site's own
/// mock style — `Issues`, `PullRequest` and `Browser` in
/// apps/web/src/components/home/Features.tsx and the devices in Everywhere.tsx:
/// flat, square-cornered panels, #0A0A0A mocks on a #FFFFFF1A tile, mono type
/// at 12px, 34px rows, the brand blue for the one thing picked. Each is drawn
/// at the site's own size in a 400×225 frame and zoomed to 1280×720, the 16:9
/// of a highlight's picture, then captured to an image for the changelog
/// (`demo/whats-new/<art>.png`), since an image is what every surface reading
/// changelog.json can show. `?art=<id>` draws one frame alone at the window's
/// corner, for that capture at a 1280×720 viewport; without it every frame is
/// listed.

const MONO = "font-mono tracking-[-0.04em]";

/// The site's tile: #FFFFFF1A over the page's black, the mock centred on it.
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="h-[720px] w-[1280px] shrink-0 overflow-hidden bg-black">
      <div style={{ zoom: 3.2 }} className="flex h-[225px] w-[400px] items-center justify-center bg-[#1A1A1A] p-6 text-white antialiased">
        {children}
      </div>
    </div>
  );
}

/// A task with its harnesses listed as the site lists issues: Claude Code the
/// one it runs on now, Codex picked in blue for its next message.
function AgentSwitch() {
  const rows: [Harness, string, string | null][] = [
    ["claude_code", "Claude Code", "now"],
    ["codex", "Codex", "next message"],
    ["grok", "Grok", null],
    ["pi", "pi", null],
  ];
  return (
    <div aria-hidden className="flex w-[300px] flex-col bg-[#0A0A0A]">
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <span className="size-1.5 shrink-0 bg-[#3FB950]" />
        <span className={`${MONO} text-xs leading-4 text-white`}>Fix login loop</span>
        <span className={`${MONO} ml-auto text-[11px] leading-[14px] text-[#8A8A8A]`}>harness</span>
      </div>
      <div className="border-t border-[#FFFFFF14]">
        {rows.map(([h, name, tag]) => {
          const picked = h === "codex";
          return (
            <div key={h} className={cn("flex h-[34px] shrink-0 items-center gap-2.5 px-2.5", picked && "bg-[#1612F8]")}>
              <AgentIcon harness={h} className={cn("size-3 shrink-0", picked ? "text-white" : "text-[#8A8A8A]")} />
              <span className={cn(MONO, "text-xs leading-4", picked ? "text-white" : "text-[#CFCFCF]")}>{name}</span>
              {tag && (
                <span className={cn(MONO, "ml-auto text-[10px] leading-3", picked ? "text-[#FFFFFFB3]" : "text-[#8A8A8A]")}>
                  {tag}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/// The iPhone as the site's Everywhere section draws it, larger: body, screen
/// and island, the task list as bars with one in blue, and a push alert
/// landing beside it.
function IPhone() {
  return (
    <svg aria-hidden viewBox="40 0 352 177" className="h-[177px] w-[352px] overflow-visible">
      <rect x="96" y="6" width="104" height="213" rx="17" fill="#2A2A2A" />
      <path d="M113 7H183" stroke="#4A4A4A" />
      <rect x="101.5" y="11" width="93" height="203" rx="12.5" fill="#0A0A0A" />
      <rect x="133" y="19" width="30" height="9.5" rx="4.75" fill="#1F1F1F" />

      <rect x="111" y="44" width="38" height="8" fill="#3D3D3D" />
      {[
        [64, "#3D3D3D", "#2E2E2E", 50],
        [84, "#1612F8", "#4A4A4A", 40],
        [104, "#3D3D3D", "#2E2E2E", 56],
        [124, "#3D3D3D", "#262626", 44],
      ].map(([y, dot, bar, w]) => (
        <g key={y as number}>
          <rect x="111" y={y as number} width="6" height="6" fill={dot as string} />
          <rect x="124" y={y as number} width={w as number} height="6" fill={bar as string} />
        </g>
      ))}
      <rect x="109" y="148" width="78" height="22" fill="#1F1F1F" stroke="#333333" />
      <rect x="115" y="154" width="30" height="5" fill="#4A4A4A" />
      <rect x="115" y="162" width="20" height="4" fill="#2E2E2E" />

      <g>
        <rect x="170" y="62" width="168" height="44" fill="#1F1F1F" stroke="#333333" />
        <rect x="179" y="71" width="14" height="14" fill="#1612F8" />
        <text x="201" y="78" dominantBaseline="central" fontSize="11" letterSpacing="-0.04em" fill="#FFFFFF" className="font-mono">
          Ready to merge
        </text>
        <text x="201" y="94" dominantBaseline="central" fontSize="9" letterSpacing="-0.04em" fill="#8A8A8A" className="font-mono">
          Fix login loop · #1015
        </text>
        <rect x="325" y="70" width="5" height="5" fill="#3FB950" />
      </g>
    </svg>
  );
}

const ART: Record<string, { name: string; Art: () => ReactNode }> = {
  "agent-switch": { name: "Switching a task's harness", Art: AgentSwitch },
  iphone: { name: "Dray on iPhone", Art: IPhone },
};

function Demo() {
  const one = new URLSearchParams(location.search).get("art");
  if (one && ART[one]) {
    const { Art } = ART[one];
    return (
      <Frame>
        <Art />
      </Frame>
    );
  }
  return (
    <div className="flex flex-col gap-10 bg-black p-10 text-white">
      {Object.entries(ART).map(([id, { name, Art }]) => (
        <section key={id} className="flex flex-col gap-3">
          <h2 className="text-ui text-white/60">
            {name} · <span className="font-mono">?art={id}</span>
          </h2>
          <Frame>
            <Art />
          </Frame>
        </section>
      ))}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
