import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";

import AgentIcon from "@/components/AgentIcon";
import type { Harness } from "@/types/events";
import { cn } from "@/lib/utils";
import { APP_STORE_QR } from "./appStoreQr";
import "../App.css";

/// Illustrations for What's New highlights, drawn in code in the site's own
/// mock style — `Issues`, `PullRequest` and `Browser` in
/// apps/web/src/components/home/Features.tsx and the devices in Everywhere.tsx:
/// flat, square-cornered panels, #0A0A0A mocks on a #FFFFFF1A tile, mono type
/// at 12px, 34px rows, the brand blue for the one thing picked. Each is drawn
/// at the site's own size in a 400×225 tile and zoomed to 2560×1440, the 16:9
/// of a highlight's picture at twice its 1280×720 so it stays sharp on a
/// Retina screen, then captured to an image for the changelog
/// (`demo/whats-new/<art>.png`), since an image is what every surface reading
/// changelog.json can show. `?art=<id>` draws one frame alone at the window's
/// corner, for that capture at a 2560×1440 viewport; without it every take is
/// listed, a row per highlight.

const MONO = "font-mono tracking-[-0.04em]";
const BLUE = "#1612F8";
const CLAUDE = "#D97757";

/// The tile, #1C1C1C: the What's New card's own fill, so a picture and the
/// title under it read as one surface. `zoom` 6.4 is the 2560×1440 capture;
/// the listing draws smaller so takes sit side by side.
function Frame({ zoom = 6.4, children }: { zoom?: number; children: ReactNode }) {
  return (
    <div style={{ width: 400 * zoom, height: 225 * zoom }} className="shrink-0 overflow-hidden bg-black">
      <div
        style={{ zoom }}
        className="relative flex h-[225px] w-[400px] items-center justify-center overflow-hidden bg-[#1C1C1C] p-6 text-white antialiased"
      >
        {children}
      </div>
    </div>
  );
}

function You({ children, small }: { children: ReactNode; small?: boolean }) {
  return (
    <div
      className={cn(
        MONO,
        "max-w-[85%] self-end bg-[#262626] text-white",
        small ? "px-1.5 py-[3px] text-[9px] leading-3" : "px-2 py-1 text-[11px] leading-[14px]",
      )}
    >
      {children}
    </div>
  );
}

/// An agent's reply under its mark, white on a tile: grey for the agent it
/// was, blue for the one it moved to, `brand` for Claude's own orange.
function Says({
  harness,
  picked,
  brand,
  small,
  children,
}: {
  harness: Harness;
  picked?: boolean;
  brand?: boolean;
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-1.5">
      <span
        className={cn("flex shrink-0 items-center justify-center", small ? "size-3" : "size-[15px]")}
        style={{ background: picked ? BLUE : brand ? CLAUDE : "#262626" }}
      >
        <AgentIcon
          harness={harness}
          className={cn(small ? "size-2" : "size-2.5", picked || brand ? "text-white" : "text-[#CFCFCF]")}
        />
      </span>
      <span className={cn(MONO, "text-[#CFCFCF]", small ? "text-[9px] leading-3" : "text-[11px] leading-[15px]")}>{children}</span>
    </div>
  );
}

function TaskHeader({ title = "Fix login loop" }: { title?: string }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[#FFFFFF14] px-3">
      <span className="size-1.5 shrink-0 bg-[#3FB950]" />
      <span className={`${MONO} text-xs leading-4 text-white`}>{title}</span>
    </div>
  );
}

/// One chat, read top to bottom: Claude Code answers, a blue line says Codex
/// took over, and Codex answers under it with everything above still there.
function HarnessOneChat() {
  return (
    <div aria-hidden className="flex w-[300px] flex-col bg-[#0A0A0A]">
      <TaskHeader />
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <You>Why does sign-in loop?</You>
        <Says harness="claude_code">The redirect fires twice. Fixed.</Says>
        <div className="flex items-center gap-2">
          <span className="h-px flex-1" style={{ background: BLUE }} />
          <span className={`${MONO} flex h-4 items-center gap-1 px-1.5 text-[9px] leading-3 text-white`} style={{ background: BLUE }}>
            <AgentIcon harness="claude_code" className="size-2 text-white" />
            Claude Code
            <svg width="9" height="6" viewBox="0 0 9 6" className="mx-0.5 shrink-0">
              <path d="M0 3H7.5M5 .5 7.5 3 5 5.5" fill="none" stroke="#FFFFFF" />
            </svg>
            Codex
            <AgentIcon harness="codex" className="size-2 text-white" />
          </span>
          <span className="h-px flex-1" style={{ background: BLUE }} />
        </div>
        <You>Now add a test for it.</You>
        <Says harness="codex" picked>
          Added login.test.ts. Passing.
        </Says>
      </div>
    </div>
  );
}

/// The same chat twice: what Claude Code had, and the same lines carried
/// into Codex with one more exchange under them.
function HarnessCarried() {
  const Pane = ({ harness, name, picked, children }: { harness: Harness; name: string; picked?: boolean; children: ReactNode }) => (
    <div className="flex w-[156px] flex-col self-stretch bg-[#0A0A0A]">
      <div className="flex h-7 shrink-0 items-center gap-1.5 px-2" style={{ background: picked ? BLUE : "#161616" }}>
        <AgentIcon harness={harness} className={cn("size-2.5", picked ? "text-white" : "text-[#CFCFCF]")} />
        <span className={`${MONO} text-[11px] leading-[14px] text-white`}>{name}</span>
      </div>
      <div className="flex flex-col gap-1.5 p-2">{children}</div>
    </div>
  );
  return (
    <div aria-hidden className="flex items-center gap-2">
      <Pane harness="claude_code" name="Claude Code">
        <You small>Why does sign-in loop?</You>
        <Says harness="claude_code" small>
          Redirect fires twice. Fixed.
        </Says>
      </Pane>
      <svg width="20" height="12" viewBox="0 0 20 12" className="shrink-0">
        <path d="M0 6H17M12 1l5 5-5 5" fill="none" stroke={BLUE} strokeWidth="2" />
      </svg>
      <Pane harness="codex" name="Codex" picked>
        <div className="flex flex-col gap-1.5 opacity-50">
          <You small>Why does sign-in loop?</You>
          <Says harness="claude_code" small>
            Redirect fires twice. Fixed.
          </Says>
        </div>
        <You small>Add a test for it.</You>
        <Says harness="codex" picked small>
          Added. Passing.
        </Says>
      </Pane>
    </div>
  );
}

/// The chat as Claude Code left it, and the composer's harness menu open
/// under it with Codex picked for the message being typed.
function HarnessComposer() {
  const rows: [Harness, string][] = [
    ["claude_code", "Claude Code"],
    ["codex", "Codex"],
    ["grok", "Grok"],
  ];
  return (
    <div aria-hidden className="flex w-[300px] flex-col bg-[#0A0A0A]">
      <div className="flex flex-col gap-2 px-3 pt-2.5 pb-2">
        <You>Why does sign-in loop?</You>
        <Says harness="claude_code" brand>
          The redirect fires twice. Fixed.
        </Says>
      </div>
      <div className="mr-2 flex w-[150px] flex-col self-end border border-[#333333] bg-[#141414] shadow-[0_8px_24px_#000000A0]">
        {rows.map(([h, name]) => {
          const picked = h === "codex";
          return (
            <div key={h} className="flex h-6 items-center gap-2 px-2" style={{ background: picked ? BLUE : undefined }}>
              <AgentIcon harness={h} className={cn("size-2.5", picked ? "text-white" : "text-[#8A8A8A]")} />
              <span className={cn(MONO, "text-[11px] leading-[14px]", picked ? "text-white" : "text-[#CFCFCF]")}>{name}</span>
            </div>
          );
        })}
      </div>
      <div className="m-2 mt-1 flex h-9 items-center gap-2 border border-[#333333] bg-[#141414] px-2">
        <span className={`${MONO} text-[11px] leading-[14px] text-white`}>Now add a test</span>
        <span className="h-3 w-px bg-white" />
        <span className={`${MONO} ml-auto flex h-5 items-center gap-1 px-1.5 text-[10px] leading-3 text-white`} style={{ background: BLUE }}>
          <AgentIcon harness="codex" className="size-2.5 text-white" />
          Codex
        </span>
      </div>
    </div>
  );
}

/// The App Store link as a scannable code, dark on white with the four-module
/// quiet zone the spec asks for, since the tile around it is dark.
function Qr({ size }: { size: number }) {
  const n = APP_STORE_QR.length + 8;
  let d = "";
  APP_STORE_QR.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "1") d += `M${x + 4} ${y + 4}h1v1h-1z`;
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className="shrink-0">
      <rect width={n} height={n} fill="#FFFFFF" />
      <path d={d} fill="#000000" />
    </svg>
  );
}

function ScanToInstall() {
  return (
    <div className="absolute top-1/2 right-7 flex -translate-y-1/2 flex-col items-center gap-2">
      <Qr size={100} />
      <span className={`${MONO} text-[11px] leading-[14px] text-white`}>Scan to install</span>
    </div>
  );
}

/// An iPhone as the site draws one, bleeding off the tile's foot.
function Phone({ left, width = 140, children }: { left: number; width?: number; children: ReactNode }) {
  return (
    <div className="absolute top-5 h-[300px] rounded-[24px] bg-[#2A2A2A] p-[5px]" style={{ left, width }}>
      <div className="relative h-full overflow-hidden rounded-[19px] bg-[#0A0A0A]">
        <div className="absolute top-[7px] left-1/2 h-[11px] w-[38px] -translate-x-1/2 rounded-full bg-[#1F1F1F]" />
        <div className="flex flex-col gap-2 px-2.5 pt-7">{children}</div>
      </div>
    </div>
  );
}

function PhoneTask({ title, dot }: { title: string; dot: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="size-1.5 shrink-0" style={{ background: dot }} />
      <span className={`${MONO} text-[10px] leading-3 text-white`}>{title}</span>
    </div>
  );
}

/// A permission card on the phone, Allow in blue: the agent asked, and the
/// reader answers from wherever they are.
function IPhonePermission() {
  return (
    <div aria-hidden className="absolute inset-0">
      <Phone left={70}>
        <PhoneTask title="Ship the release" dot={BLUE} />
        <Says harness="codex" small>
          Tests pass. Pushing the tag.
        </Says>
        <div className="flex flex-col gap-1.5 border border-[#333333] bg-[#161616] p-2">
          <span className={`${MONO} text-[8px] leading-[10px] text-[#8A8A8A]`}>Codex wants to run</span>
          <span className={`${MONO} text-[10px] leading-3 text-white`}>git push --tags</span>
          <div className="mt-0.5 flex gap-1">
            <span className={`${MONO} flex h-[18px] flex-1 items-center justify-center text-[9px] text-white`} style={{ background: BLUE }}>
              Allow
            </span>
            <span className={`${MONO} flex h-[18px] flex-1 items-center justify-center bg-[#262626] text-[9px] text-[#CFCFCF]`}>
              Deny
            </span>
          </div>
        </div>
      </Phone>
      <ScanToInstall />
    </div>
  );
}

function Alert({ title, body, mark }: { title: string; body: string; mark: string }) {
  return (
    <div className="flex items-center gap-2 bg-[#1F1F1F] p-[7px]">
      <span className="size-[14px] shrink-0" style={{ background: mark }} />
      <div className="flex min-w-0 flex-col">
        <span className={`${MONO} text-[9px] leading-3 text-white`}>{title}</span>
        <span className={`${MONO} truncate text-[8px] leading-[10px] text-[#8A8A8A]`}>{body}</span>
      </div>
    </div>
  );
}

/// An iPhone 16 Pro Max drawn to its own proportions (a 440×956pt screen,
/// 62pt corners, the Dynamic Island 126×37pt at 11pt), titanium rim and side
/// buttons, bleeding off the tile's foot, a real screenshot on its screen.
function RealPhone({ left, width = 150, src }: { left: number; width?: number; src: string }) {
  const pt = (width - 10) / 440;
  const radius = 62 * pt;
  const button = (side: "left" | "right", top: number, height: number) => (
    <span
      className="absolute w-[2px] rounded-[1px] bg-gradient-to-b from-[#5A5A5E] via-[#3A3A3C] to-[#5A5A5E]"
      style={{ [side]: -1.5, top: top * pt, height: height * pt }}
    />
  );
  return (
    <div className="absolute top-4" style={{ left, width }}>
      {button("left", 150, 50)}
      {button("left", 235, 85)}
      {button("left", 335, 85)}
      {button("right", 270, 135)}
      {button("right", 560, 70)}
      <div
        className="relative bg-gradient-to-br from-[#8E8E93] via-[#3A3A3C] to-[#6E6E73] p-[1.5px] shadow-[0_20px_40px_#000000C0]"
        style={{ height: 956 * pt + 10, borderRadius: radius + 5 }}
      >
        <div className="h-full bg-black p-[3.5px]" style={{ borderRadius: radius + 3.5 }}>
          <div className="relative h-full overflow-hidden bg-black" style={{ borderRadius: radius }}>
            <img src={src} alt="" className="absolute inset-0 size-full object-cover object-top" />
            <span
              className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black"
              style={{ top: 11 * pt, width: 126 * pt, height: 37 * pt }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/// The app itself in the phone: the bot chat from its App Store screenshots
/// (`01-bot-chat`, the 6.9-inch export, kept at its full 1320px so the
/// 2x capture only ever shrinks it), a merge and two waiting tasks on it.
function IPhoneApp() {
  return (
    <div aria-hidden className="absolute inset-0">
      <RealPhone left={70} src="/demo/whats-new/ios-bot-chat.png" />
      <ScanToInstall />
    </div>
  );
}

/// An agent's question answered on the phone, one choice picked in blue,
/// with the alert that brought the reader there still at the top.
function IPhoneQuestion() {
  return (
    <div aria-hidden className="absolute inset-0">
      <Phone left={70}>
        <PhoneTask title="Add saved searches" dot={BLUE} />
        <div className="flex flex-col gap-1.5 border border-[#333333] bg-[#161616] p-2">
          <span className={`${MONO} text-[10px] leading-3 text-white`}>Where should they live?</span>
          {["Postgres", "SQLite", "Both"].map((o, i) => (
            <span
              key={o}
              className={cn(MONO, "flex h-[18px] items-center px-1.5 text-[9px]", i === 0 ? "text-white" : "bg-[#262626] text-[#CFCFCF]")}
              style={i === 0 ? { background: BLUE } : undefined}
            >
              {i + 1}. {o}
            </span>
          ))}
        </div>
      </Phone>
      <div className="absolute top-[30px] left-[44px] w-[160px] shadow-[0_8px_24px_#000000A0]">
        <Alert title="Claude Code asks" body="Add saved searches" mark={BLUE} />
      </div>
      <ScanToInstall />
    </div>
  );
}

const ROWS: { title: string; takes: Record<string, { name: string; Art: () => ReactNode }> }[] = [
  {
    title: "Switch a task's harness mid-session",
    takes: {
      "harness-chat": { name: "A · One chat, the mark changes", Art: HarnessOneChat },
      "harness-carried": { name: "B · Carried into Codex", Art: HarnessCarried },
      "harness-composer": { name: "C · Picked in the composer", Art: HarnessComposer },
    },
  },
  {
    title: "Dray on iPhone",
    takes: {
      "iphone-permission": { name: "A · Allow from anywhere", Art: IPhonePermission },
      "iphone-app": { name: "B · The app in a real frame", Art: IPhoneApp },
      "iphone-question": { name: "C · Answer a question", Art: IPhoneQuestion },
    },
  },
];

function Demo() {
  const one = new URLSearchParams(location.search).get("art");
  const art = ROWS.flatMap((r) => Object.entries(r.takes)).find(([id]) => id === one);
  if (art) {
    const { Art } = art[1];
    return (
      <Frame>
        <Art />
      </Frame>
    );
  }
  return (
    <div className="flex min-h-screen flex-col gap-12 bg-black p-10 text-white">
      {ROWS.map(({ title, takes }) => (
        <section key={title} className="flex flex-col gap-4">
          <h2 className="text-lg text-white">{title}</h2>
          <div className="flex flex-wrap gap-6">
            {Object.entries(takes).map(([id, { name, Art }]) => (
              <figure key={id} className="flex flex-col gap-2">
                <Frame zoom={1.4}>
                  <Art />
                </Frame>
                <figcaption className="text-ui text-white/60">
                  {name} · <span className="font-mono">?art={id}</span>
                </figcaption>
              </figure>
            ))}
          </div>
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
