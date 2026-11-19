import type { ReactNode } from "react";

// The sign-in pages in the desktop app's gate language (#1277): black, the
// striped tiles along the bottom, a mono label over a light heading, and
// 220px cards in a row. In the site's light scheme the same page turns white
// with pale tiles, the way the homepage does; the blue card stays blue.

/// The mono line over the heading; red where it says something went wrong.
export function Label({ children, danger = false }: { children: ReactNode; danger?: boolean }) {
  return (
    <p
      className={`flex items-center gap-2 font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase lg:pl-[102px] ${danger ? "text-[#FF6467] light:text-[#E5484D]" : "text-white/50 light:text-black/50"}`}
    >
      <Mark />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return (
    <h1 className="mt-3.5 mb-10 font-inter text-[28px] leading-8 font-light tracking-[-0.03em] text-balance sm:text-[36px] sm:leading-10 lg:pl-[102px]">
      {children}
    </h1>
  );
}

export function Cards({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-[2px] sm:flex-row">{children}</div>;
}

const CARD = "flex h-[140px] min-w-0 flex-1 basis-0 flex-col justify-between p-6 text-left sm:h-[220px]";
const GRAY = `${CARD} bg-[#1C1C1C] light:bg-[#F4F4F5]`;
const ACTIVE =
  "cursor-pointer outline-none transition-colors hover:bg-[#242424] focus-visible:bg-[#242424] disabled:cursor-default disabled:hover:bg-[#1C1C1C] light:hover:bg-[#EBEBED] light:focus-visible:bg-[#EBEBED] light:disabled:hover:bg-[#F4F4F5]";

/// One gray card: an icon up top, what it does at the foot. A link with
/// `href`, a button with `onClick`, and only words with neither; `disabled`
/// with neither draws a way in that isn't open yet, faded.
export function Card({
  icon,
  label,
  detail,
  corner = false,
  href,
  onClick,
  disabled = false,
}: {
  icon: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  corner?: boolean;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const off = disabled && !href && !onClick;
  const inner = (
    <>
      <span className={`flex items-start justify-between ${off ? "opacity-40" : ""}`}>
        {icon}
        {corner && <CornerArrow className="stroke-white/40 light:stroke-black/40" />}
      </span>
      <span className="flex flex-col gap-0.5">
        <span
          className={`text-[17px] leading-6 tracking-[-0.01em] ${off ? "text-white/40 light:text-black/40" : "text-white/80 light:text-black/80"}`}
        >
          {label}
        </span>
        {detail && <span className="text-[13px] leading-[18px] text-white/40 light:text-black/45">{detail}</span>}
      </span>
    </>
  );
  if (href)
    return (
      <a href={href} className={`${GRAY} ${ACTIVE}`}>
        {inner}
      </a>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} disabled={disabled} className={`${GRAY} ${ACTIVE}`}>
        {inner}
      </button>
    );
  return (
    <div aria-disabled={off || undefined} className={GRAY}>
      {inner}
    </div>
  );
}

/// The blue card that carries the step forward: a submit button inside a
/// form, or a link with `href`.
export function BlueCard({
  label,
  detail,
  icon,
  href,
  busy = false,
  corner = false,
}: {
  label: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  href?: string;
  busy?: boolean;
  corner?: boolean;
}) {
  const cls = `${CARD} cursor-pointer bg-[#1612F8] text-white outline-none transition-opacity hover:opacity-90 focus-visible:ring-1 focus-visible:ring-white/60 focus-visible:ring-inset disabled:cursor-default disabled:opacity-70`;
  const inner = (
    <>
      <span className="flex items-start justify-between">
        {busy ? <Spinner size={20} /> : (icon ?? <ArrowIcon />)}
        {corner && <CornerArrow className="stroke-white/70" />}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[17px] leading-6 font-medium tracking-[-0.01em]">{label}</span>
        {detail && <span className="text-[13px] leading-[18px] text-white/70">{detail}</span>}
      </span>
    </>
  );
  if (href)
    return (
      <a href={href} className={cls}>
        {inner}
      </a>
    );
  return (
    <button type="submit" disabled={busy} className={cls}>
      {inner}
    </button>
  );
}

/// A form field drawn as a card: its name up top, what is typed at the foot,
/// and a rule under the one being typed in.
export function FieldCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={`${GRAY} cursor-text ${RULE_WITHIN}`}>
      <span className="font-mono text-[11px] leading-[14px] tracking-[0.06em] text-white/50 uppercase light:text-black/50">
        {label}
      </span>
      {children}
    </label>
  );
}

/// The rule under the field being typed in.
export const RULE = "shadow-[inset_0_-2px_0_#FFFFFFE6] light:shadow-[inset_0_-2px_0_#000000E6]";
const RULE_WITHIN =
  "focus-within:shadow-[inset_0_-2px_0_#FFFFFFE6] light:focus-within:shadow-[inset_0_-2px_0_#000000E6]";

/// The input a `FieldCard` holds.
export const FIELD =
  "w-full min-w-0 bg-transparent text-[17px] leading-6 tracking-[-0.01em] text-white/90 caret-white outline-none placeholder:text-white/30 autofill:shadow-[inset_0_0_0_1000px_#1C1C1C] autofill:[-webkit-text-fill-color:#ffffffe6] light:text-black/90 light:caret-black light:placeholder:text-black/30 light:autofill:shadow-[inset_0_0_0_1000px_#F4F4F5] light:autofill:[-webkit-text-fill-color:#000000e6]";

/// The row under the cards: a back arrow, then the step's other ways out.
export function Links({ onBack, children }: { onBack?: () => void; children?: ReactNode }) {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-3">
      {onBack && (
        <button type="button" onClick={onBack} aria-label="Back" className="-m-1 cursor-pointer p-1 text-white/90 hover:text-white light:text-black/90 light:hover:text-black">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
            <path d="M20 12H6M12 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
          </svg>
        </button>
      )}
      {children}
    </div>
  );
}

export const LINK =
  "cursor-pointer font-mono text-[11px] leading-[14px] tracking-[0.06em] text-white/50 uppercase transition-colors hover:text-white disabled:cursor-default disabled:hover:text-white/50 light:text-black/50 light:hover:text-black light:disabled:hover:text-black/50";

export function Mark() {
  return (
    <svg width="11" height="14" viewBox="0 0 159 200" aria-hidden className="shrink-0">
      <path
        fill="currentColor"
        d="M101.004 0C104.603 0 107.52 2.926 107.52 6.536V18.301C107.52 36.349 122.108 50.98 140.102 50.98H152.484C156.083 50.98 159 53.907 159 57.516V142.484C159 146.093 156.083 149.02 152.484 149.02H140.102C122.108 149.02 107.52 163.651 107.52 181.699V193.464C107.52 197.074 104.603 200 101.004 200H0.326C0.146 200 0 199.854 0 199.673V134.967C0 134.787 0.146 134.641 0.326 134.641H61.254C79.249 134.641 93.836 120.009 93.836 101.961V98.039C93.836 79.991 79.249 65.36 61.254 65.36H0.326C0.146 65.36 0 65.213 0 65.033V0.327C0 0.146 0.146 0 0.326 0H101.004Z"
      />
    </svg>
  );
}

function CornerArrow({ className }: { className: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden className={`shrink-0 ${className}`}>
      <path d="M7 17 17 7M7 7h10v10" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Icons at 90% of the text colour, card labels at 80%: the gate's picked Z1
// frame, so either scheme's text colour carries them.
const ICON = "currentColor";

function ArrowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <path d="M4 12h14M12 5l7 7-7 7" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

export function Spinner({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke={ICON} strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

export function GitHubIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden className="opacity-90">
      <path
        fill={ICON}
        d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8 0 3.2.9.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1 .9 2.2v3.3c0 .3.1.7.8.6A12 12 0 0 0 12 .3"
      />
    </svg>
  );
}

export function GoogleIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export function MailIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden className="opacity-90">
      <path fill={ICON} d="M2 5h20v1.4l-10 6.4L2 6.4z" />
      <path fill={ICON} d="M2 8.8l10 6.4 10-6.4V19H2z" />
    </svg>
  );
}

export function SignOutIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden className="opacity-90">
      <path d="M9 4H4v16h5M15 8l4 4-4 4M19 12H9" fill="none" stroke={ICON} strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

export function ServerIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden className="opacity-90">
      <path d="M3 4h18v7H3zM3 13h18v7H3z" fill="none" stroke={ICON} strokeWidth="2" strokeLinecap="square" />
      <path d="M7 7.5h2M7 16.5h2" stroke={ICON} strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

export function OrgIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden className="opacity-90">
      <path d="M4 21V3h10v18M14 9h6v12M2 21h20M8 7h2M8 11h2M8 15h2" fill="none" stroke={ICON} strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden className="opacity-90">
      <path d="M5 5l14 14M19 5 5 19" fill="none" stroke={ICON} strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

/// The gate's tiles: `[x, y, tone]` on a 60px grid of a 1440×300 strip.
/// Each tone is a dark fill and its light twin, as faint on white as the
/// dark one is on black.
const TILES: [number, number, string][] = [
  ...pts("0 180,60 60,180 240,300 180,420 240,480 180,660 180,720 120,960 120,1020 180,1020 240,1080 240,1140 120,1140 240,1200 240,1260 120", "fill-[#121212] light:fill-[#F2F2F3]"),
  ...pts("0 240,120 240,180 120,180 180,240 180,300 120,420 180,540 180,540 240,660 120,660 240,720 240,780 240,840 120,900 120,960 180,1260 240,1380 240", "fill-[#0C0C0C] light:fill-[#F8F8F9]"),
  ...pts("60 180,60 240,240 240,300 240,360 60,360 240,600 180,600 240,840 180,840 240,900 240,1140 180,1260 60,1320 240", "fill-[#181818] light:fill-[#EBEBED]"),
  ...pts("480 240,960 240,1260 180", "fill-[#1F1F1F] light:fill-[#E3E3E6]"),
];

function pts(list: string, tone: string): [number, number, string][] {
  return list.split(",").map((p) => {
    const [x, y] = p.split(" ").map(Number);
    return [x, y, tone];
  });
}

export function Tiles() {
  return (
    <svg
      aria-hidden
      width="1440"
      height="300"
      viewBox="0 0 1440 300"
      className="pointer-events-none absolute bottom-0 left-1/2 max-w-none -translate-x-1/2"
    >
      <defs>
        <pattern id="signin-stripes" width="6" height="60" patternUnits="userSpaceOnUse">
          {/* Black bars darken a dark tile; on white, white bars lighten. */}
          <rect width="2" height="60" className="fill-[#00000080] light:fill-white" />
        </pattern>
      </defs>
      {TILES.map(([x, y, tone]) => (
        <g key={`${x},${y}`}>
          <rect x={x} y={y} width="60" height="60" className={tone} />
          <rect x={x} y={y} width="60" height="60" fill="url(#signin-stripes)" />
        </g>
      ))}
    </svg>
  );
}
