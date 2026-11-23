import type { ReactNode } from "react";

import WindowControls from "@/components/layout/WindowControls";
import type { SignInMethod } from "@/types/events";

/// What the gate is showing. `revoked` is a saved sign-in the site turned
/// away; `waiting` a browser sign-in in flight, `finishing` once the browser
/// is back and it can no longer be cancelled. `emailOff` is the site saying
/// email sign-in isn't open yet, `lastUsed` the way in this app last took.
export type GateView =
  | {
      kind: "choose";
      revoked: boolean;
      error: string | null;
      offline: boolean;
      emailOff: boolean;
      lastUsed: SignInMethod | null;
    }
  | { kind: "waiting"; method: SignInMethod; finishing: boolean };

const METHOD: Record<SignInMethod, string> = { github: "GitHub", google: "Google", email: "email" };

/// The window a signed-out reader sees instead of the app (#1277): black, the
/// site's striped tiles along the bottom, and the three ways in as cards.
/// Always dark, whatever the theme, since it is the brand's own page.
export default function SignInGate({
  view,
  onPick,
  onOpenAgain,
  onCancel,
  onSkip,
}: {
  view: GateView | null;
  onPick: (method: SignInMethod) => void;
  onOpenAgain: () => void;
  onCancel: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[1000] flex flex-col overflow-hidden bg-black text-white select-none">
      <Tiles />
      <header data-tauri-drag-region="deep" className="relative flex h-(--titlebar-h,40px) shrink-0 items-center justify-end">
        <WindowControls />
      </header>
      {view && (
        <main className="relative flex flex-1 items-center justify-center px-10 pb-10">
          <div className="flex w-full max-w-[960px] flex-col">{body(view, { onPick, onOpenAgain, onCancel, onSkip })}</div>
        </main>
      )}
    </div>
  );
}

function body(
  view: GateView,
  act: { onPick: (m: SignInMethod) => void; onOpenAgain: () => void; onCancel: () => void; onSkip: () => void },
) {
  if (view.kind === "waiting")
    return (
      <>
        <Label>Signing in with {METHOD[view.method]}</Label>
        <Heading>{view.finishing ? "Finishing sign-in." : "Finish signing in in your browser."}</Heading>
        <Cards>
          <Card icon={<Spinner />} label={view.finishing ? "Finishing sign-in" : "Waiting for your browser"} />
          {/* Too late to cancel once the browser is back: the site is
              already re-keying this machine's link. */}
          <Card icon={<OpenIcon />} label="Open again" onClick={view.finishing ? undefined : act.onOpenAgain} dim={view.finishing} />
          <Card icon={<CloseIcon />} label="Cancel" onClick={view.finishing ? undefined : act.onCancel} dim={view.finishing} />
        </Cards>
      </>
    );
  const { error, offline, revoked, emailOff, lastUsed } = view;
  const tag = (method: SignInMethod) => lastUsed === method && <LastUsed />;
  const failed = !offline && error;
  const label = failed ? failed : revoked ? "You've been signed out" : "Welcome to Dray";
  const heading = offline
    ? "Check your connection, or skip for now."
    : failed
      ? "Pick an account to try again."
      : revoked
        ? "Sign in again. Your agents are still running."
        : "Pick an account to sign in with.";
  return (
    <>
      <Label danger={Boolean(failed)}>{label}</Label>
      <Heading>{heading}</Heading>
      <Cards>
        <Card icon={<GitHubIcon />} label="GitHub" tag={tag("github")} corner onClick={() => act.onPick("github")} />
        <Card icon={<GoogleIcon />} label="Google" tag={tag("google")} corner onClick={() => act.onPick("google")} />
        {emailOff ? (
          <Card icon={<MailIcon />} label="Email" detail="Coming in the next few days" tag={tag("email")} off />
        ) : (
          <Card icon={<MailIcon />} label="Email" tag={tag("email")} corner onClick={() => act.onPick("email")} />
        )}
        {offline && <Card icon={<SkipIcon />} label="Skip for now" onClick={act.onSkip} />}
      </Cards>
    </>
  );
}

function Label({ children, danger = false }: { children: ReactNode; danger?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 pl-[102px] font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase max-lg:pl-0 ${danger ? "text-[#FF6467]" : "text-white/50"}`}
    >
      <Mark />
      {children}
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h1 className="mt-3.5 mb-10 pl-[102px] text-[36px] leading-10 font-light tracking-[-0.03em] text-white max-lg:pl-0">
      {children}
    </h1>
  );
}

function Cards({ children }: { children: ReactNode }) {
  return <div className="flex gap-[2px]">{children}</div>;
}

/// One card. Without `onClick` it only says something, like the waiting one;
/// `dim` greys out one that can't be used right now, and `off` fades a way in
/// that isn't open yet, leaving its `detail` and `tag` readable, as the site does.
function Card({
  icon,
  label,
  detail,
  tag,
  corner = false,
  dim = false,
  off = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  tag?: ReactNode;
  corner?: boolean;
  dim?: boolean;
  off?: boolean;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span className={`flex items-start justify-between ${off ? "opacity-40" : ""}`}>
        {icon}
        {corner && <CornerArrow />}
      </span>
      <span className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <span className="flex flex-col gap-0.5">
          <span className={`text-[17px] leading-6 tracking-[-0.01em] ${off ? "text-white/40" : "text-white/80"}`}>{label}</span>
          {detail && <span className="text-[13px] leading-[18px] text-white/40">{detail}</span>}
        </span>
        {/* Wraps under the label on a card too narrow for both, like the
            offline gate's four at the window's narrowest. */}
        {tag && <span className="ml-auto">{tag}</span>}
      </span>
    </>
  );
  const cls = `flex h-[220px] min-w-0 flex-1 basis-0 flex-col justify-between bg-[#1C1C1C] p-6 text-left ${dim ? "opacity-40" : ""}`;
  if (!onClick)
    return (
      <div aria-disabled={off || undefined} className={cls}>
        {inner}
      </div>
    );
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${cls} cursor-pointer outline-none transition-colors hover:bg-[#242424] focus-visible:bg-[#242424] focus-visible:ring-1 focus-visible:ring-white/40`}
    >
      {inner}
    </button>
  );
}

/// The site's tag on the card this app last signed in with.
function LastUsed() {
  return (
    <span className="bg-white/10 px-1.5 py-[3px] font-mono text-[10px] leading-3 tracking-[0.06em] whitespace-nowrap text-white/70 uppercase">
      Last used
    </span>
  );
}

const MARK =
  "M101.004 0C104.603 0 107.52 2.926 107.52 6.536V18.301C107.52 36.349 122.108 50.98 140.102 50.98H152.484C156.083 50.98 159 53.907 159 57.516V142.484C159 146.093 156.083 149.02 152.484 149.02H140.102C122.108 149.02 107.52 163.651 107.52 181.699V193.464C107.52 197.074 104.603 200 101.004 200H0.326C0.146 200 0 199.854 0 199.673V134.967C0 134.787 0.146 134.641 0.326 134.641H61.254C79.249 134.641 93.836 120.009 93.836 101.961V98.039C93.836 79.991 79.249 65.36 61.254 65.36H0.326C0.146 65.36 0 65.213 0 65.033V0.327C0 0.146 0.146 0 0.326 0H101.004Z";

function Mark() {
  return (
    <svg width="11" height="14" viewBox="0 0 159 200" aria-hidden>
      <path d={MARK} fill="currentColor" />
    </svg>
  );
}

function CornerArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path d="M7 17 17 7M7 7h10v10" fill="none" stroke="#FFFFFF66" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Icons at 90%, the cards' labels at 80%: the picked Z1 frame.
const ICON = "#FFFFFFE6";

function GitHubIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden>
      <path
        fill={ICON}
        d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8 0 3.2.9.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1 .9 2.2v3.3c0 .3.1.7.8.6A12 12 0 0 0 12 .3"
      />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden>
      <path fill={ICON} d="M2 5h20v1.4l-10 6.4L2 6.4z" />
      <path fill={ICON} d="M2 8.8l10 6.4 10-6.4V19H2z" />
    </svg>
  );
}

function SkipIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden>
      <path d="M4 12h14M12 5l7 7-7 7" fill="none" stroke={ICON} strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden>
      <path d="M14 3h7v7M10 14 21 3M19 14v7H3V5h7" fill="none" stroke={ICON} strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden>
      <path d="M5 5l14 14M19 5 5 19" fill="none" stroke={ICON} strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" className="animate-spin" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="#FFFFFF33" strokeWidth="2" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke={ICON} strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

/// The black-on-black tiles along the bottom, each striped like the site's.
/// `[x, y, fill]` on a 60px grid of a 1440×300 strip, the picked frame's own.
const TILES: [number, number, string][] = [
  ...pts("0 180,60 60,180 240,300 180,420 240,480 180,660 180,720 120,960 120,1020 180,1020 240,1080 240,1140 120,1140 240,1200 240,1260 120", "#121212"),
  ...pts("0 240,120 240,180 120,180 180,240 180,300 120,420 180,540 180,540 240,660 120,660 240,720 240,780 240,840 120,900 120,960 180,1260 240,1380 240", "#0C0C0C"),
  ...pts("60 180,60 240,240 240,300 240,360 60,360 240,600 180,600 240,840 180,840 240,900 240,1140 180,1260 60,1320 240", "#181818"),
  ...pts("480 240,960 240,1260 180", "#1F1F1F"),
];

function pts(list: string, fill: string): [number, number, string][] {
  return list.split(",").map((p) => {
    const [x, y] = p.split(" ").map(Number);
    return [x, y, fill];
  });
}

// Shared with What's New so the brand's two full-window pages read as one
// family.
export { Heading as GateHeading };

function Tiles() {
  return (
    <svg
      aria-hidden
      width="1440"
      height="300"
      viewBox="0 0 1440 300"
      className="pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2"
    >
      <defs>
        <pattern id="gate-stripes" width="6" height="60" patternUnits="userSpaceOnUse">
          <rect width="2" height="60" fill="#00000080" />
        </pattern>
      </defs>
      {TILES.map(([x, y, fill]) => (
        <g key={`${x},${y}`}>
          <rect x={x} y={y} width="60" height="60" fill={fill} />
          <rect x={x} y={y} width="60" height="60" fill="url(#gate-stripes)" />
        </g>
      ))}
    </svg>
  );
}
