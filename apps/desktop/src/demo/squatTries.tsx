import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";

import { BreakCard } from "@/components/BreakOverlay";
import {
  type Limb,
  type Pt,
  Figure,
  SHOULDER,
  Scene,
  Sparkle,
  Squat,
  at,
  ease,
  lerp,
  useClock,
} from "@/components/breakScenes";
import DemoThemeBar from "@/demo/ThemeBar";
import "../App.css";

const TEXT = "Micro-dose ten squats. No prescription.";

/// Down slow, a beat at the bottom, up quicker, a breath at the top: 0..1.
function depth(t: number, period = 2.4) {
  const c = (t % period) / period;
  return c < 0.12 ? 0 : c < 0.5 ? ease((c - 0.12) / 0.38) : c < 0.62 ? 1 : 1 - ease((c - 0.62) / 0.3);
}

/// Face on, feet wide, knees pushing out over the toes, hands clasped at the
/// chest the way a goblet squat holds its weight.
function FaceOn() {
  const t = useClock() ?? 1.35;
  const d = depth(t);
  const hip: Pt = [80, lerp(68, 84, d)];
  const hands: Pt = [80, hip[1] - SHOULDER + 13];
  return (
    <Scene>
      <Figure
        pose={{
          hip,
          spine: 0,
          shoulders: 8,
          arms: [
            { ik: hands, flip: 1 },
            { ik: hands, flip: -1 },
          ],
          legs: [
            { ik: [64, 102], flip: 1 },
            { ik: [96, 102], flip: -1 },
          ],
        }}
      />
      <Sparkle x={38} y={44} t={t} />
      <Sparkle x={124} y={36} r={4} t={t} phase={0.5} />
    </Scene>
  );
}

/// Side on, hands laced behind the head, elbows back so the arms stay off the
/// face, torso kept tall.
function Prisoner() {
  const t = useClock() ?? 1.35;
  const d = depth(t);
  const hip: Pt = [lerp(85, 73, d), lerp(68, 84, d)];
  const spine = lerp(2, 28, d);
  const arm: Limb = { ik: at(at(hip, spine, SHOULDER + 8), spine - 90, 10), flip: -1 };
  const leg: Limb = { ik: [86, 102], flip: -1 };
  return (
    <Scene>
      <path d="M40 104 L132 104" strokeWidth={2.5} />
      <Figure pose={{ hip, spine, look: 0.7, nod: 4 - spine, arms: [arm, arm], legs: [leg, leg] }} />
      <Sparkle x={42} y={44} t={t} />
      <Sparkle x={130} y={30} r={4} t={t} phase={0.5} />
    </Scene>
  );
}

/// Down, then up hard enough to leave the floor, arms swinging from behind to
/// overhead, landing soft back into the next one.
function Jump() {
  const t = useClock() ?? 0.75;
  const c = (t % 2.2) / 2.2;
  let d = 0;
  let lift = 0;
  let swing = 176;
  if (c < 0.3) {
    d = ease(c / 0.3);
    swing = lerp(176, 215, d);
  } else if (c < 0.4) {
    d = 1;
    swing = 215;
  } else if (c < 0.55) {
    const u = ease((c - 0.4) / 0.15);
    d = 1 - u;
    lift = 10 * u;
    swing = lerp(215, 45, u);
  } else if (c < 0.7) {
    const u = ease((c - 0.55) / 0.15);
    d = 0.4 * u;
    lift = 10 * (1 - u);
    swing = lerp(45, 150, u);
  } else {
    const u = ease((c - 0.7) / 0.3);
    d = 0.4 * (1 - u);
    swing = lerp(150, 176, u);
  }
  const spine = lerp(2, 38, d);
  const arm: Limb = { fk: [swing, 0] };
  const leg: Limb = { ik: [86, 102 - lift], flip: -1 };
  return (
    <Scene>
      {/* Scaled in about the floor so arms overhead at the top of the jump stay in the box. */}
      <g transform="translate(12.9 15.6) scale(0.85)" strokeWidth={4.1}>
        <path d="M40 104 L132 104" strokeWidth={2.9} />
        <Figure
          pose={{
            hip: [lerp(85, 72, d), lerp(68, 84, d) - lift],
            spine,
            look: 0.7,
            nod: 4 - spine,
            arms: [arm, arm],
            legs: [leg, leg],
          }}
        />
      </g>
      <Sparkle x={34} y={40} t={t} />
      <Sparkle x={138} y={52} r={4} t={t} phase={0.5} />
    </Scene>
  );
}

/// The current squat with a tally in the corner: one mark a rep, struck
/// through at five, wiped at ten.
function Tally() {
  const t = useClock() ?? 1.35 + 2.4 * 6;
  const reps = Math.floor(t / 2.4) + ((t % 2.4) / 2.4 >= 0.5 ? 1 : 0);
  const shown = reps === 0 ? 0 : ((reps - 1) % 10) + 1;
  const marks: string[] = [];
  for (let i = 0; i < shown; i++) {
    const x = 16 + Math.floor(i / 5) * 24;
    const k = i % 5;
    marks.push(k < 4 ? `M${x + k * 5} 20 L${x + k * 5} 34` : `M${x - 3} 31 L${x + 18} 23`);
  }
  const d = depth(t);
  const spine = lerp(2, 38, d);
  const arm: Limb = { fk: [lerp(162, 92, d), lerp(-24, 0, d)] };
  const leg: Limb = { ik: [86, 102], flip: -1 };
  return (
    <Scene>
      {marks.length > 0 && <path d={marks.join(" ")} strokeWidth={2.5} />}
      <path d="M40 104 L132 104" strokeWidth={2.5} />
      <Figure
        pose={{ hip: [lerp(85, 72, d), lerp(68, 84, d)], spine, look: 0.7, nod: 4 - spine, arms: [arm, arm], legs: [leg, leg] }}
      />
    </Scene>
  );
}

const TRIES: { name: string; Scene: () => ReactNode }[] = [
  { name: "1 · Side on, arms forward (current)", Scene: Squat },
  { name: "2 · Face on, hands at chest", Scene: FaceOn },
  { name: "3 · Hands behind head", Scene: Prisoner },
  { name: "4 · Jump squat", Scene: Jump },
  { name: "5 · Rep tally to ten", Scene: Tally },
];

/// Takes on the squat card's drawing side by side, for picking one.
function Demo() {
  return (
    <div className="flex flex-col gap-10 p-8 pb-48">
      <DemoThemeBar />
      <div className="flex flex-wrap gap-10">
        {TRIES.map(({ name, Scene }) => (
          <figure key={name} className="flex flex-col items-center gap-3">
            <BreakCard text={TEXT} Scene={Scene} />
            <figcaption className="text-sm text-muted-foreground">{name}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
