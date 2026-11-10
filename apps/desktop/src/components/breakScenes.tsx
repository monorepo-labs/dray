import { type ReactNode, useEffect, useState } from "react";

type Pt = [number, number];
type V3 = [number, number, number];
/// A two-bone limb: forward angles (upper, then the bend relative to it), or a
/// target the end reaches for with the middle joint bent to `flip`'s side.
type Limb = { fk: [number, number] } | { ik: Pt; flip: 1 | -1 };
/// `shoulders` is half the shoulder width; left out, both arms leave one point,
/// which reads fine side on and crowds the head face on. `nod` turns the head
/// off the spine's line.
type Pose = { hip: Pt; spine: number; look?: number; nod?: number; shoulders?: number; arms: [Limb, Limb]; legs: [Limb, Limb] };

const NECK = 36;
const SHOULDER = 32;
const HEAD = 46;
const ARM: [number, number] = [17, 16];
const LEG: [number, number] = [17, 17];

const rad = (d: number) => (d * Math.PI) / 180;
/** Angles are degrees clockwise from straight up: 90 is right, 180 is down. */
const at = (p: Pt, a: number, len: number): Pt => [p[0] + Math.sin(rad(a)) * len, p[1] - Math.cos(rad(a)) * len];
const lerp = (a: number, b: number, w: number) => a + (b - a) * w;
const ease = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};
/** 0..1 and back, resting a beat at each end. */
const swing = (t: number, period: number) => ease((1 - Math.cos((2 * Math.PI * t) / period)) / 2);
const pt = (p: Pt) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
const line = (ps: Pt[]) => ps.map((p, i) => `${i ? "L" : "M"}${pt(p)}`).join(" ");

/// Where a limb's middle joint and end land. Reaching past full length
/// straightens it toward the target rather than stretching it.
function joint(root: Pt, limb: Limb, [l1, l2]: [number, number]): [Pt, Pt] {
  if ("fk" in limb) {
    const mid = at(root, limb.fk[0], l1);
    return [mid, at(mid, limb.fk[0] + limb.fk[1], l2)];
  }
  const dx = limb.ik[0] - root[0];
  const dy = limb.ik[1] - root[1];
  const d = Math.min(Math.hypot(dx, dy), l1 + l2 - 0.01);
  const base = Math.atan2(dy, dx);
  const bend = Math.acos(Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  const a = base + limb.flip * bend;
  return [
    [root[0] + Math.cos(a) * l1, root[1] + Math.sin(a) * l1],
    [root[0] + Math.cos(base) * d, root[1] + Math.sin(base) * d],
  ];
}

const limb = (root: Pt, l: Limb, len: [number, number]) => line([root, ...joint(root, l, len)]);

function Head({ c: [hx, hy], look = 0 }: { c: Pt; look?: number }) {
  const ex = hx + look * 3;
  return (
    <>
      <circle cx={hx} cy={hy} r={10} />
      <circle cx={ex - 4} cy={hy - 2} r={1.4} fill="currentColor" stroke="none" />
      <circle cx={ex + 4} cy={hy - 2} r={1.4} fill="currentColor" stroke="none" />
      <path d={`M${ex - 5} ${hy + 3} Q${ex} ${hy + 8} ${ex + 5} ${hy + 3}`} strokeWidth={2.5} />
    </>
  );
}

/// The stick figure, drawn from a pose so every scene shares one body and
/// limbs keep their length however they move.
function Figure({ pose }: { pose: Pose }) {
  const { hip, spine, look = 0, nod = 0, shoulders = 0, arms, legs } = pose;
  const shoulder = at(hip, spine, SHOULDER);
  const sl = at(shoulder, spine - 90, shoulders);
  const sr = at(shoulder, spine + 90, shoulders);
  return (
    <>
      <Head c={at(at(hip, spine, NECK), spine + nod, HEAD - NECK)} look={look} />
      <path
        d={[
          line([hip, at(hip, spine, NECK)]),
          shoulders ? line([sl, sr]) : "",
          limb(sl, arms[0], ARM),
          limb(sr, arms[1], ARM),
          limb(hip, legs[0], LEG),
          limb(hip, legs[1], LEG),
        ].join(" ")}
      />
    </>
  );
}

const REDUCED = "(prefers-reduced-motion: reduce)";

/// Seconds since the scene mounted, one render a frame; null under reduced
/// motion, where each scene holds its best pose instead. Follows the setting
/// live, so turning it on mid-break stops the figure.
function useClock(): number | null {
  const [still, setStill] = useState(() => matchMedia(REDUCED).matches);
  const [t, setT] = useState(0);
  useEffect(() => {
    const mq = matchMedia(REDUCED);
    const change = () => setStill(mq.matches);
    mq.addEventListener("change", change);
    return () => mq.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (still) return;
    const start = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      setT((now - start) / 1000);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [still]);
  return still ? null : t;
}

/// One drawing for the break card's tile: a 160×110 box, ground at y≈102,
/// drawn in the card's ink so every palette colours it.
function Scene({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden viewBox="0 0 160 110" className="h-32" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

/// A plus that twinkles, slowly and out of step with its neighbours.
function Sparkle({ x, y, r = 5, t, phase = 0 }: { x: number; y: number; r?: number; t: number; phase?: number }) {
  const q = r * (0.7 + 0.3 * Math.sin(2 * Math.PI * (t / 1.8 + phase)));
  return <path d={`M${x} ${y - q} L${x} ${y + q} M${x - q} ${y} L${x + q} ${y}`} strokeWidth={2.5} />;
}

/// The right arm held out at shoulder height, elbow soft and a little
/// forward, in body space: x right, y down, z toward the viewer. The left arm
/// is its mirror.
const REACH: V3[] = [
  [8, 0, 0],
  [24, 3, 5],
  [39, 6, 11],
];

/// A standing twist: hips planted, the shoulders and outstretched arms turn
/// about the spine. Seen from a little above, so what swings toward the viewer
/// sits lower, and the arm swinging behind fades back.
function Twist() {
  const t = useClock() ?? 0;
  const turn = rad(58) * (2 * swing(t, 3.4) - 1);
  const cs = Math.cos(turn);
  const sn = Math.sin(turn);
  const view = ([x, y, z]: V3): [Pt, number] => {
    const depth = z * cs - x * sn;
    return [[80 + x * cs + z * sn, 38 + y + 0.2 * depth], depth];
  };
  const [right, left] = [1, -1].map((side) => REACH.map(([x, y, z]) => view([side * x, y, z])));
  const hip: Pt = [80, 68];
  const back = right[1][1] < left[1][1] ? right : left;
  const front = back === right ? left : right;
  return (
    <Scene>
      <Head c={[80 + 1.5 * sn, 22]} look={0.8 * sn} />
      <path d={[line([hip, [80, 32]]), limb(hip, { ik: [70, 101], flip: 1 }, LEG), limb(hip, { ik: [90, 101], flip: -1 }, LEG)].join(" ")} />
      <path d={line(back.map((p) => p[0]))} opacity={1 - 0.5 * ease(-back[2][1] / 25)} />
      <path d={line([left[0][0], right[0][0]])} />
      <path d={line(front.map((p) => p[0]))} />
    </Scene>
  );
}

/// Pull-ups, face on: a wide grip, the elbows flaring out as the chin rises
/// over the bar, and back down to a dead hang, legs straight.
function PullUp() {
  const t = useClock() ?? 1.1;
  const c = (t % 2.8) / 2.8;
  const up = c < 0.1 ? 0 : c < 0.42 ? ease((c - 0.1) / 0.32) : c < 0.56 ? 1 : 1 - ease((c - 0.56) / 0.38);
  const bar = 22;
  const sway = 1.2 * Math.sin((2 * Math.PI * t) / 2.8 - 1);
  return (
    <Scene>
      {/* Drawn larger than the box and scaled in, so the chin over the bar and the hang both fit. */}
      <g transform="translate(12 4.85) scale(0.85)" strokeWidth={4.1}>
        <path d={`M34 ${bar} L126 ${bar} M40 -10 L40 ${bar} M120 -10 L120 ${bar}`} strokeWidth={4.6} />
        <Figure
          pose={{
            hip: [80, lerp(bar + 28.5, bar + 1, up) + SHOULDER],
            spine: 0,
            shoulders: 8,
            arms: [
              { ik: [54, bar], flip: -1 },
              { ik: [106, bar], flip: 1 },
            ],
            legs: [{ fk: [174 + sway, 0] }, { fk: [186 + sway, 0] }],
          }}
        />
      </g>
    </Scene>
  );
}

/// A sampled arm, relative to its shoulder, so two shapes can be blended point
/// by point however differently they bend.
type Arm = Pt[];
const SAMPLES = 16;
const curved = (c1: Pt, c2: Pt, e: Pt): Arm =>
  Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const u = i / SAMPLES;
    const v = 1 - u;
    return [3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u ** 3 * e[0], 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u ** 3 * e[1]];
  });
const bent = (elbow: Pt, hand: Pt): Arm =>
  Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const u = (2 * i) / SAMPLES;
    return u <= 1 ? [elbow[0] * u, elbow[1] * u] : [lerp(elbow[0], hand[0], u - 1), lerp(elbow[1], hand[1], u - 1)];
  });
/// Blends two right-side arms in polar terms about the shoulder, so the arm
/// sweeps round its side instead of shrinking through the body.
const sweep = (p: Arm, q: Arm, w: number): Arm =>
  p.map((a, i) => {
    const polar = ([x, y]: Pt) => {
      const ang = Math.atan2(x, -y);
      return [Math.hypot(x, y), ang < -Math.PI / 2 ? ang + 2 * Math.PI : ang];
    };
    const [r1, a1] = polar(a);
    const [r2, a2] = polar(q[i]);
    const r = lerp(r1, r2, w);
    const an = lerp(a1, a2, w);
    return [Math.sin(an) * r, -Math.cos(an) * r];
  });
const mirror = (arm: Arm): Arm => arm.map(([x, y]) => [-x, y]);

const ARM_UP = curved([18, -4], [23, -22], [19, -36]);
const ARM_OVER = curved([21, -21], [9, -42], [-26, -37]);
const HAND_ON_HIP = bent([15, 13], [3, 25]);
const HAND_ON_HIP_LEANT = bent([14, 14], [-2, 20]);

/// A side bend, one side and then the other: the spine curves, the top arm
/// arcs over the head, the other hand rests on the hip. Between sides the arms
/// trade places.
function SideBend() {
  const t = useClock() ?? 1.2;
  const u = t % 3;
  const w = u < 0.95 ? ease(u / 0.95) : u < 1.45 ? 1 : ease((2.4 - u) / 0.95);
  const k = u < 2.4 ? 0 : ease((u - 2.4) / 0.6);
  const bend = -46 * w;
  const hip: Pt = [80, 68];
  const c = at(hip, 0.12 * bend, 20);
  const neck = at(c, bend, 16);
  // Lower down the spine than the neck, so the arm arcing over clears the head.
  const q = 0.72;
  const shoulder: Pt = [0, 1].map((i) => (1 - q) ** 2 * hip[i] + 2 * q * (1 - q) * c[i] + q * q * neck[i]) as Pt;
  const overArm = sweep(sweep(ARM_UP, ARM_OVER, w), HAND_ON_HIP, k);
  const hipArm = mirror(sweep(sweep(HAND_ON_HIP, HAND_ON_HIP_LEANT, w), ARM_UP, k));
  const draw = (arm: Arm) => line(arm.map(([x, y]) => [shoulder[0] + x, shoulder[1] + y]));
  return (
    <Scene>
      {/* Every other bend is the first one mirrored; at the hand-over both drawings are the same. */}
      <g transform={Math.floor(t / 3) % 2 ? "matrix(-1 0 0 1 160 0)" : undefined}>
        <Head c={at(neck, bend, 10)} look={-0.6 * w} />
        <path
          d={[
            `M${pt(hip)} Q${pt(c)} ${pt(neck)}`,
            draw(overArm),
            draw(hipArm),
            limb(hip, { ik: [68, 101], flip: 1 }, LEG),
            limb(hip, { ik: [92, 101], flip: -1 }, LEG),
          ].join(" ")}
        />
      </g>
      <Sparkle x={30} y={46} t={t} />
      <Sparkle x={130} y={46} r={4} t={t} phase={0.5} />
    </Scene>
  );
}

/// Stepping into a lunge as the arms sweep up overhead, and back.
function Lunge() {
  const t = useClock() ?? 1.6;
  const w = swing(t, 3.2);
  return (
    <Scene>
      <Figure
        pose={{
          hip: [80, lerp(67, 77, w)],
          spine: 0,
          arms: [{ fk: [lerp(-168, -42, w), lerp(0, 8, w)] }, { fk: [lerp(168, 42, w), lerp(0, -8, w)] }],
          legs: [
            { ik: [lerp(74, 56, w), 101], flip: -1 },
            { ik: [lerp(86, 100, w), 101], flip: -1 },
          ],
        }}
      />
      <Sparkle x={34} y={36} t={t} />
      <Sparkle x={128} y={30} r={4} t={t} phase={0.4} />
    </Scene>
  );
}

/// A walk cycle in place, the footprints sliding away behind.
function Strut() {
  const t = useClock() ?? 0.2;
  const p = (2 * Math.PI * t) / 1.1;
  const sn = Math.sin(p);
  const cs = Math.cos(p);
  const slide = (t * 40) % 22;
  const prints: string[] = [];
  for (let x = 8 - slide; x < 72; x += 22) if (x > 2) prints.push(`M${x.toFixed(2)} 101 L${(x + 8).toFixed(2)} 101`);
  return (
    <Scene>
      {prints.length > 0 && <path d={prints.join(" ")} strokeWidth={3} />}
      <Figure
        pose={{
          hip: [98, 67 - 1.5 * Math.cos(2 * p)],
          spine: 5,
          look: 0.6,
          arms: [{ fk: [180 + 30 * sn, -30] }, { fk: [180 - 30 * sn, -30] }],
          legs: [{ fk: [180 - 26 * sn, 50 * Math.max(0, cs)] }, { fk: [180 + 26 * sn, 50 * Math.max(0, -cs)] }],
        }}
      />
    </Scene>
  );
}

/// Push-ups, side on: one rigid line from the toes, hands planted under the
/// shoulders, the elbows folding back toward the feet on the way down. Down
/// slow, a beat at the bottom, up quicker, a breath at the top.
function PushUp() {
  const t = useClock() ?? 0;
  const c = (t % 2.4) / 2.4;
  const down = c < 0.14 ? 0 : c < 0.58 ? ease((c - 0.14) / 0.44) : c < 0.66 ? 1 : 1 - ease((c - 0.66) / 0.3);
  const feet: Pt = [134, 102];
  const hand: Pt = [82, 102];
  const spine = lerp(29.5, 6, down) - 90;
  const hip = at(feet, spine, 34);
  return (
    <Scene>
      <path d="M10 104 L150 104" strokeWidth={2.5} />
      <Figure
        pose={{
          hip,
          spine,
          look: -0.7,
          nod: lerp(12, 34, down),
          arms: [
            { ik: hand, flip: -1 },
            { ik: hand, flip: -1 },
          ],
          legs: [
            { ik: feet, flip: 1 },
            { ik: feet, flip: 1 },
          ],
        }}
      />
      <Sparkle x={112} y={44} t={t} />
      <Sparkle x={138} y={64} r={4} t={t} phase={0.5} />
    </Scene>
  );
}

/// Each line with its drawings; the card picks one of a line's at random.
export const BREAK_LINES: { text: string; scenes: { name: string; Scene: () => ReactNode }[] }[] = [
  {
    text: "Your agents can wait. Your spine can't.",
    scenes: [
      { name: "Twist", Scene: Twist },
      { name: "Pull-up", Scene: PullUp },
    ],
  },
  {
    text: "Stretch, you gorgeous workaholic.",
    scenes: [
      { name: "Side bend", Scene: SideBend },
      { name: "Lunge", Scene: Lunge },
    ],
  },
  {
    text: "Legs exist. Go use them.",
    scenes: [{ name: "Strut", Scene: Strut }],
  },
  {
    text: "Give me ten push‑ups. Right now.",
    scenes: [{ name: "Push-up", Scene: PushUp }],
  },
];
