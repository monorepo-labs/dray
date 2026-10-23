"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { ContactShadows, Environment, Lightformer, Line, RoundedBox } from "@react-three/drei";
import * as THREE from "three";

import Orb from "@/components/app/Orb";
import { SessionRow } from "@/components/app/Sidebar";

const LOOP = 12;
const LID_OPEN = -(Math.PI / 2 + 0.18);
const STILL_AT = 10;
type Phase = { loadDone: boolean; iosDone: boolean };

function phaseAt(t: number): Phase {
  return { loadDone: t >= 5, iosDone: t >= 7.2 };
}

/// `plain` leaves the maker's mark off the hardware. `freeze` holds the scene
/// and its orbs on the finished frame whatever the reader's motion setting,
/// for taking a still of it.
export default function RemoteServersScene({ plain = false, freeze = false }: { plain?: boolean; freeze?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const leaders = useRef<(SVGLineElement | null)[]>([]);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(false);
  const still = reduced || freeze;
  const [livePhase, setPhase] = useState<Phase>(() => phaseAt(0));
  const phase = still ? phaseAt(STILL_AT) : livePhase;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setReduced(media.matches);
    };
    update();
    media.addEventListener("change", update);
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    if (wrap.current) io.observe(wrap.current);
    return () => {
      io.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);

  return (
    <div ref={wrap} data-app-window className="relative h-full w-full select-none" aria-hidden>
      <Canvas
        // Nothing renders off screen: the loop is decoration, not a clock.
        frameloop={visible && !still ? "always" : "demand"}
        dpr={2}
        camera={{ position: [0.6, 4.3, 10.8], fov: 23 }}
        gl={{ antialias: true }}
        onCreated={({ camera }) => camera.lookAt(0, 0.85, 0)}
      >
        <Scene still={still} phase={phase} onPhase={setPhase} cards={cards} leaders={leaders} plain={plain} />
      </Canvas>
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        {[0, 1].map(i => <line key={i} ref={el => void (leaders.current[i] = el)} stroke="#72757a" strokeOpacity={0.55} strokeWidth={1} />)}
      </svg>
      {/* Plain DOM over the canvas, placed each frame from a point in the
          scene. drei's Html renders through a second React root, which
          StrictMode's double mount left empty half the time. */}
      <Card ref={(el) => void (cards.current[0] = el)}>
        <SessionRow title="iOS release build" trailing={<Settling done={phase.iosDone} paused={freeze} />} />
        <SessionRow title="Screenshot every page" trailing={<Orb paused={freeze} />} />
      </Card>
      <Card ref={(el) => void (cards.current[1] = el)}>
        <SessionRow title="Load test staging" trailing={<Settling done={phase.loadDone} paused={freeze} />} />
        <SessionRow title="Nightly backup script" trailing={<Orb paused={freeze} />} />
      </Card>
    </div>
  );
}

const MINI_AT = new THREE.Vector3(-3.45, 0, -0.55);
const RACK_AT = new THREE.Vector3(3.45, 0, 0.65);
const CARD_ANCHORS = [MINI_AT, RACK_AT].map((p) => p.clone().setY(1.65));

function Scene({
  still,
  phase,
  onPhase,
  cards,
  leaders,
  plain,
}: {
  plain: boolean;
  still: boolean;
  phase: Phase;
  onPhase: (p: Phase) => void;
  cards: React.RefObject<(HTMLDivElement | null)[]>;
  leaders: React.RefObject<(SVGLineElement | null)[]>;
}) {
  const last = useRef(phase);
  const elapsed = useRef(0);
  const v = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ camera, size }, delta) => {
    if (!still) elapsed.current += Math.min(delta, 0.1);
    const t = still ? STILL_AT : elapsed.current % LOOP;

    CARD_ANCHORS.forEach((p, i) => {
      const el = cards.current[i];
      if (!el) return;
      v.copy(p).project(camera);
      el.style.visibility = "visible";
      const line = leaders.current[i];
      if (line) {
        line.setAttribute("x1", String(((v.x + 1) / 2) * size.width));
        line.setAttribute("y1", String(((1 - v.y) / 2) * size.height + 36 * size.width / 1128));
        v.copy(i === 0 ? MINI_AT : RACK_AT).setY(0.52).project(camera);
        line.setAttribute("x2", String(((v.x + 1) / 2) * size.width));
        line.setAttribute("y2", String(((1 - v.y) / 2) * size.height));
        v.copy(p).project(camera);
      }
      el.style.transform = `translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px) translate(-50%, -50%) scale(${Math.min(1, size.width / 1128)})`;
    });
    const next = phaseAt(t);
    const prev = last.current;
    if (next.loadDone !== prev.loadDone || next.iosDone !== prev.iosDone) {
      last.current = next;
      onPhase(next);
    }
  });

  return (
    <>
      <ambientLight intensity={0.45} />
      <directionalLight position={[3, 6, 5]} intensity={1.6} />
      {/* Reflections come from soft panels rather than a fetched HDR, so the
          metal reads as metal with nothing downloaded. */}
      <Environment resolution={256} environmentIntensity={1.2}>
        <Lightformer form="rect" intensity={2} position={[0, 5, 2]} scale={[10, 2, 1]} rotation-x={Math.PI / 2} />
        <Lightformer form="rect" intensity={1.5} position={[-6, 2, 1]} scale={[3, 6, 1]} rotation-y={Math.PI / 2} />
        <Lightformer form="rect" intensity={1.5} position={[6, 2, 1]} scale={[3, 6, 1]} rotation-y={-Math.PI / 2} />
        <Lightformer form="rect" intensity={0.6} position={[0, 1, 6]} scale={[10, 3, 1]} />
        {/* Behind and low: what a lid top or a deck seen from the front reflects. */}
        <Lightformer form="rect" intensity={0.9} position={[0, 1.5, -7]} scale={[10, 3, 1]} />
      </Environment>

      <group scale={1.16} rotation-y={-0.12}>
        <MacBook phase={phase} cards={cards} />
      </group>
      <group position={MINI_AT} rotation-y={0.28}>
        <MacMini plain={plain} />
      </group>
      <group position={RACK_AT} rotation-y={-0.30}>
        <RackServer />
      </group>

      <Connections />
      <ContactShadows position={[0, 0, 0]} opacity={0.65} scale={14} blur={2.8} far={3} resolution={512} frames={1} />
    </>
  );
}

function Connections() {
  const paths = useMemo(() => [
    [[-1.65, 0.12, 0.9], [-2.1, 0.08, 1.15], [-3.35, 0.08, 1.10], [-3.45, 0.16, 0.32]],
    [[1.7, 0.12, 1.1], [2.2, 0.08, 1.9], [3.5, 0.08, 2.15], [3.7, 0.16, 1.51]],
  ].map(points => new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z))).getPoints(48)), []);
  return <group>{paths.map((points, i) => <Line key={i} points={points} color="#858990" transparent opacity={0.65} lineWidth={1.1} />)}</group>;
}

const W = 3.1;
const D = 2.15;
const BASE_H = 0.11;
const LID_H = 2.02;
const LID_T = 0.045;
const SCREEN_W = W - 0.12;
const SCREEN_H = LID_H - 0.13;

// Extruding the outline keeps broad corner radii independent of the thin metal edge.
function Shell({ width, depth, height, radius, position, color = "#292c30", roughness = 0.27 }: {
  width: number; depth: number; height: number; radius: number;
  position: [number, number, number]; color?: string; roughness?: number;
}) {
  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    const x = -width / 2, y = -depth / 2, r = radius;
    shape.moveTo(x + r, y);
    shape.lineTo(x + width - r, y);
    shape.quadraticCurveTo(x + width, y, x + width, y + r);
    shape.lineTo(x + width, y + depth - r);
    shape.quadraticCurveTo(x + width, y + depth, x + width - r, y + depth);
    shape.lineTo(x + r, y + depth);
    shape.quadraticCurveTo(x, y + depth, x, y + depth - r);
    shape.lineTo(x, y + r);
    shape.quadraticCurveTo(x, y, x + r, y);
    const bevel = Math.min(height / 4, 0.025);
    const g = new THREE.ExtrudeGeometry(shape, { depth: height - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, steps: 1, curveSegments: 10 });
    g.rotateX(-Math.PI / 2);
    g.translate(0, bevel, 0);
    return g;
  }, [width, depth, height, radius]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry} position={position}><meshStandardMaterial color={color} metalness={0.92} roughness={roughness} /></mesh>;
}

function MacBook({ phase, cards }: { phase: Phase; cards: React.RefObject<(HTMLDivElement | null)[]> }) {
  const screen = useScreen(phase, cards);
  return (
    <group position={[0, 0.045, 0.35]}>
      <Shell width={W - 0.02} depth={D - 0.02} height={0.025} radius={0.12} position={[0, 0, 0]} color="#202124" />
      <Shell width={W} depth={D} height={BASE_H} radius={0.12} position={[0, 0.025, 0]} />
      <Shell width={2.48} depth={1.02} height={0.009} radius={0.065} position={[0, 0.14, -0.35]} color="#0d0e10" />
      <Keyboard />
      <Shell width={1.24} depth={0.69} height={0.005} radius={0.055} position={[0, 0.137, 0.63]} color="#17181a" />
      <Shell width={1.225} depth={0.675} height={0.005} radius={0.05} position={[0, 0.141, 0.63]} />
      <Shell width={0.48} depth={0.04} height={0.018} radius={0.018} position={[0, 0.115, D / 2 - 0.016]} color="#202124" />
      {[-1, 1].map(side => <group key={side}>
        <Perforations cols={3} rows={26} pitchX={0.027} pitchY={0.032} position={[side * 1.35, 0.142, -0.76]} rotation={[-Math.PI / 2, 0, 0]} />
        {[0, 1].map(i => <RoundedBox key={i} args={[0.008, 0.035, 0.14]} radius={0.004} position={[side * (W / 2 + 0.012), 0.08, -0.58 + i * 0.28]}><meshStandardMaterial color="#090a0c" /></RoundedBox>)}
      </group>)}
      <mesh position={[0, 0.145, -D / 2 + 0.05]} rotation-z={Math.PI / 2}>
        <cylinderGeometry args={[0.055, 0.055, W - 0.35, 32]} />
        <meshStandardMaterial color="#151619" metalness={0.7} roughness={0.3} />
      </mesh>
      <group position={[0, 0.17, -D / 2 + 0.02]} rotation-x={LID_OPEN}>
        <Shell width={W} depth={LID_H} height={LID_T} radius={0.11} position={[0, 0, LID_H / 2]} />
        <group position={[0, -0.006, LID_H / 2]} rotation-x={Math.PI / 2}>
          <RoundedBox args={[W - 0.035, LID_H - 0.035, 0.012]} radius={0.005}><meshStandardMaterial color="#08090a" roughness={0.2} metalness={0.3} /></RoundedBox>
          <mesh position={[0, 0.018, 0.008]}>
            <planeGeometry args={[SCREEN_W, SCREEN_H]} />
            <meshBasicMaterial map={screen} toneMapped={false} />
          </mesh>
          <mesh position={[0, LID_H / 2 - 0.06, 0.013]}><circleGeometry args={[0.009, 16]} /><meshStandardMaterial color="#172833" metalness={0.8} roughness={0.12} /></mesh>
        </group>
      </group>
    </group>
  );
}

function Keyboard() {
  const keys = useMemo(() => {
    const keys: { x: number; z: number; w: number; h: number }[] = [];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 14; c++) {
      keys.push({ x: (c - 6.5) * 0.169, z: -0.78 + r * 0.165, w: 0.15, h: r === 0 ? 0.09 : 0.145 });
    }
    [-1.10, -0.93, -0.76, 0.76, 0.93, 1.10].forEach(x => keys.push({ x, z: 0.045, w: 0.15, h: 0.13 }));
    keys.push({ x: 0, z: 0.045, w: 1.19, h: 0.13 });
    return keys;
  }, []);
  const lettering = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1536;
    canvas.height = 640;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#a7a9ad";
    ctx.font = "22px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const labels = ["esc · · · · · · · · · · · · ◉", "` 1 2 3 4 5 6 7 8 9 0 − = ⌫", "⇥ Q W E R T Y U I O P [ ] |", "⇪ A S D F G H J K L ; ′ ↵ ·", "⇧ Z X C V B N M , . / ⇧ ↑ ·"].map(row => row.split(" "));
    keys.forEach((k, i) => {
      if (i >= 70) return;
      ctx.fillText(labels[Math.floor(i / 14)][i % 14] ?? "", (k.x / 2.5 + 0.5) * 1536, ((k.z + 0.35) / 1.05 + 0.5) * 640);
    });
    return new THREE.CanvasTexture(canvas);
  }, [keys]);
  useEffect(() => () => lettering.dispose(), [lettering]);
  return <group>{keys.map((k, i) => <group key={i}>
    <RoundedBox args={[k.w, 0.017, k.h]} radius={0.007} smoothness={2} position={[k.x, 0.155, k.z]}><meshStandardMaterial color="#121315" roughness={0.5} /></RoundedBox>
  </group>)}
    <mesh position={[0, 0.165, -0.35]} rotation-x={-Math.PI / 2}><planeGeometry args={[2.5, 1.05]} /><meshBasicMaterial map={lettering} transparent depthWrite={false} /></mesh>
  </group>;
}

function Perforations({ cols, rows, pitchX, pitchY, position, rotation = [0, 0, 0] }: {
  cols: number; rows: number; pitchX: number; pitchY: number;
  position: [number, number, number]; rotation?: [number, number, number];
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const m = new THREE.Matrix4();
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) ref.current?.setMatrixAt(y * cols + x, m.makeTranslation(x * pitchX, y * pitchY, 0));
    if (ref.current) ref.current.instanceMatrix.needsUpdate = true;
  }, [cols, rows, pitchX, pitchY]);
  return <instancedMesh ref={ref} args={[undefined, undefined, cols * rows]} position={position} rotation={rotation}>
    <circleGeometry args={[Math.min(pitchX, pitchY) * 0.27, 6]} /><meshBasicMaterial color="#0b0c0e" />
  </instancedMesh>;
}

const PX_W = 1024;
const PX_H = Math.round((PX_W * SCREEN_H) / SCREEN_W);

type Row = { title: string; trailing: "orb" | string; unread?: boolean; active?: boolean };

/// A texture keeps the app on the display in perspective without a second React root.
function useScreen(phase: Phase, cards: React.RefObject<(HTMLDivElement | null)[]>) {
  const canvas = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = PX_W;
    c.height = PX_H;
    return c;
  }, []);
  const texture = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [canvas]);
  useEffect(() => () => texture.dispose(), [texture]);

  const rows = useMemo<Row[]>(
    () => [
      { title: "Homepage drawings", trailing: "orb", active: true },
      { title: "Load test staging", trailing: phase.loadDone ? "now" : "orb", unread: phase.loadDone },
      { title: "iOS release build", trailing: phase.iosDone ? "now" : "orb", unread: phase.iosDone },
      { title: "Nightly backup script", trailing: "orb" },
      { title: "Screenshot every page", trailing: "orb" },
      { title: "Fix the sidebar flicker", trailing: "5m" },
    ],
    [phase.loadDone, phase.iosDone],
  );

  const family = useMemo(() => getComputedStyle(document.body).fontFamily, []);
  const drawn = useRef(-1);
  const lastRows = useRef<Row[]>([]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    // The orbs are the only motion, and 30fps of them is plenty.
    if (t - drawn.current < 1 / 30 && lastRows.current === rows) return;
    drawn.current = t;
    lastRows.current = rows;
    drawScreen(canvas.getContext("2d")!, rows, family, cards.current[0]?.querySelector("svg"));
    texture.needsUpdate = true;
  });
  return texture;
}

function drawScreen(ctx: CanvasRenderingContext2D, rows: Row[], family: string, workingOrb?: SVGSVGElement | null) {
  ctx.fillStyle = "#121214";
  ctx.fillRect(0, 0, PX_W, PX_H);

  ctx.fillStyle = "#000";
  roundRect(ctx, PX_W / 2 - 64, -14, 128, 40, 14);
  ctx.fill();

  ["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(36 + i * 28, 36, 9, 0, Math.PI * 2);
    ctx.fill();
  });

  const side = 488;
  const rowH = 84;
  rows.forEach((r, i) => {
    const y = 76 + i * rowH;
    const mid = y + rowH / 2;
    if (r.active) {
      ctx.fillStyle = "rgba(255,255,255,0.09)";
      roundRect(ctx, 16, y + 6, side - 32, rowH - 12, 16);
      ctx.fill();
    }
    if (r.unread) {
      ctx.fillStyle = "oklch(0.7 0.15 163)";
      roundRect(ctx, 20, mid - 16, 5, 32, 3);
      ctx.fill();
    }
    ctx.font = `400 31px ${family}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ececee";
    ctx.textAlign = "left";
    ctx.fillText(r.title, 40, mid, side - 150);
    if (r.trailing === "orb") drawOrb(ctx, workingOrb, side - 52, mid);
    else {
      ctx.font = `400 28px ${family}`;
      ctx.fillStyle = "#8e8e93";
      ctx.textAlign = "right";
      ctx.fillText(r.trailing, side - 36, mid);
    }
  });

  const x0 = side + 8;
  ctx.fillStyle = "#202022";
  roundRect(ctx, x0, 64, PX_W - x0 - 16, PX_H - 80, 18);
  ctx.fill();
  ctx.textAlign = "left";
  ctx.font = `400 22px ${family}`;
  ctx.fillStyle = "#a2a2a7";
  ctx.fillText("dray / Homepage drawings", x0 + 24, 98);
  ctx.fillStyle = "#353537";
  roundRect(ctx, x0 + 60, 143, 398, 76, 18);
  ctx.fill();
  ctx.fillStyle = "#e7e7e9";
  ctx.fillText("Refresh the homepage drawings", x0 + 80, 181);
  ctx.fillStyle = "#c4c4c8";
  ["I'll match the current app layout", "and add the remote servers.", "", "Three machines. One workspace.", "Your agents keep running."].forEach((line, i) => ctx.fillText(line, x0 + 28, 270 + i * 36));
  ctx.fillStyle = "#96969c";
  ctx.font = `400 20px ${family}`;
  ctx.fillText("Working…", x0 + 28, 475);
  ctx.strokeStyle = "#444447";
  ctx.lineWidth = 2;
  roundRect(ctx, x0 + 20, PX_H - 116, PX_W - x0 - 44, 76, 18);
  ctx.stroke();
  ctx.fillStyle = "#8e8e93";
  ctx.fillText("Message your agent", x0 + 38, PX_H - 83);
}

// Use the live app orb's dots, so the screen and the cards share its exact design.
function drawOrb(ctx: CanvasRenderingContext2D, svg: SVGSVGElement | null | undefined, x: number, y: number) {
  if (!svg) return;
  const size = svg.viewBox.baseVal.width;
  ctx.save();
  ctx.translate(x - 17, y - 17);
  ctx.scale(34 / size, 34 / size);
  ctx.fillStyle = "#eee";
  svg.querySelectorAll("circle").forEach(dot => {
    ctx.globalAlpha = Number(dot.getAttribute("fill-opacity") ?? 1);
    ctx.beginPath();
    ctx.arc(Number(dot.getAttribute("cx")), Number(dot.getAttribute("cy")), Number(dot.getAttribute("r")), 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function AppleMark({ y }: { y: number }) {
  const shapes = useMemo(() => {
    const apple = new THREE.Shape();
    apple.moveTo(0, 0.075);
    apple.bezierCurveTo(-0.17, 0.17, -0.2, -0.015, -0.10, -0.14);
    apple.bezierCurveTo(-0.05, -0.20, -0.035, -0.14, 0, -0.14);
    apple.bezierCurveTo(0.05, -0.14, 0.07, -0.20, 0.12, -0.12);
    apple.lineTo(0.15, -0.065);
    apple.bezierCurveTo(0.06, -0.035, 0.07, 0.045, 0.145, 0.07);
    apple.bezierCurveTo(0.10, 0.14, 0.045, 0.10, 0, 0.075);
    const leaf = new THREE.Shape();
    leaf.moveTo(0.005, 0.11);
    leaf.bezierCurveTo(0, 0.18, 0.04, 0.21, 0.09, 0.21);
    leaf.bezierCurveTo(0.09, 0.15, 0.05, 0.12, 0.005, 0.11);
    return [apple, leaf];
  }, []);
  return <mesh position={[0, y, 0]} rotation-x={-Math.PI / 2} scale={0.72}><shapeGeometry args={[shapes, 20]} /><meshStandardMaterial color="#4a4d52" metalness={1} roughness={0.3} /></mesh>;
}

function MacMini({ plain }: { plain: boolean }) {
  const S = 1.65;
  const H = 0.34;
  return (
    <group>
      <Shell width={S - 0.15} depth={S - 0.15} height={0.055} radius={0.25} position={[0, 0.025, 0]} color="#101113" />
      <Shell width={S} depth={S} height={H} radius={0.23} position={[0, 0.075, 0]} color="#b9bcc1" roughness={0.24} />
      {!plain && <AppleMark y={H + 0.078} />}
      {/* Front: two USB-C ports, the headphone jack, the power light. */}
      {[-0.32, -0.18].map((x) => (
        <RoundedBox key={x} args={[0.09, 0.028, 0.01]} radius={0.012} position={[x, H * 0.45 + 0.075, S / 2 + 0.029]}>
          <meshStandardMaterial color="#1a1b1d" roughness={0.6} />
        </RoundedBox>
      ))}
      <mesh position={[-0.07, H * 0.45 + 0.075, S / 2 + 0.030]}>
        <circleGeometry args={[0.014, 16]} />
        <meshStandardMaterial color="#1a1b1d" />
      </mesh>
      <mesh position={[0.48, H * 0.45 + 0.075, S / 2 + 0.030]}>
        <circleGeometry args={[0.012, 16]} />
        <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={2} />
      </mesh>
    </group>
  );
}

function RackServer() {
  const front = 0.88;
  return (
    <group position={[0, 0.065, 0]}>
      <Shell width={2.3} depth={1.8} height={0.4} radius={0.035} position={[0, 0, 0]} color="#62666d" roughness={0.32} />
      <Shell width={2.26} depth={1.69} height={0.012} radius={0.025} position={[0, 0.405, -0.035]} color="#85898f" roughness={0.36} />
      <RoundedBox args={[2.33, 0.41, 0.055]} radius={0.012} position={[0, 0.2, front]}><meshStandardMaterial color="#272a2f" metalness={0.8} roughness={0.3} /></RoundedBox>
      {[-1, 1].map(side => <group key={side} position={[side * 1.23, 0.2, front]}>
        <RoundedBox args={[0.15, 0.41, 0.04]} radius={0.012}><meshStandardMaterial color="#74777d" metalness={0.95} roughness={0.24} /></RoundedBox>
        {[-0.12, 0.12].map(y => <mesh key={y} position={[0, y, 0.025]}><circleGeometry args={[0.025, 16]} /><meshStandardMaterial color="#090a0b" /></mesh>)}
        <RoundedBox args={[0.04, 0.19, 0.10]} radius={0.019} position={[side * -0.02, 0, 0.07]}><meshStandardMaterial color="#17191c" roughness={0.35} metalness={0.6} /></RoundedBox>
      </group>)}
      {Array.from({ length: 6 }, (_, i) => <group key={i} position={[-0.9 + (i % 3) * 0.51, 0.105 + Math.floor(i / 3) * 0.19, front + 0.033]}>
        <RoundedBox args={[0.48, 0.165, 0.035]} radius={0.012}><meshStandardMaterial color="#34383e" metalness={0.4} roughness={0.46} /></RoundedBox>
        <Perforations cols={9} rows={3} pitchX={0.032} pitchY={0.033} position={[-0.19, -0.033, 0.02]} />
        <RoundedBox args={[0.07, 0.12, 0.025]} radius={0.009} position={[0.17, 0, 0.025]}><meshStandardMaterial color="#60646a" metalness={0.9} roughness={0.28} /></RoundedBox>
        <Led position={[0.11, -0.052, 0.023]} seed={i} />
      </group>)}
      <Perforations cols={9} rows={6} pitchX={0.04} pitchY={0.045} position={[0.58, 0.08, front + 0.031]} />
      <mesh position={[1.04, 0.29, front + 0.034]}><circleGeometry args={[0.032, 24]} /><meshStandardMaterial color="#aeb3bb" metalness={1} roughness={0.2} /></mesh>
      <Led position={[1.04, 0.29, front + 0.037]} seed={99} steady />
      {[0, 1].map(i => <mesh key={i} position={[1.04, 0.10 + i * 0.065, front + 0.031]}><planeGeometry args={[0.065, 0.03]} /><meshBasicMaterial color="#08090b" /></mesh>)}
      {[-0.96, 0.96].map(x => [-0.66, 0.64].map(z => <mesh key={`${x}:${z}`} position={[x, 0.421, z]} rotation-x={-Math.PI / 2}><circleGeometry args={[0.018, 16]} /><meshStandardMaterial color="#272a30" metalness={1} roughness={0.2} /></mesh>))}
      {[0, 1, 2].map(i => <Shell key={i} width={0.015} depth={1.1} height={0.008} radius={0.004} position={[-0.8 + i * 0.8, 0.419, -0.04]} color="#73777e" />)}
    </group>
  );
}

/// Activity lights keep the hardware visibly running between session completions.
function Led({ position, seed, steady = false }: { position: [number, number, number]; seed: number; steady?: boolean }) {
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    if (!mat.current || steady) return;
    const t = clock.elapsedTime * (6 + (seed % 5)) + seed * 1.7;
    mat.current.emissiveIntensity = Math.sin(t) > 0.1 ? 2.4 : 0.25;
  });
  return (
    <mesh position={position}>
      <boxGeometry args={[0.025, 0.025, 0.005]} />
      <meshStandardMaterial ref={mat} color="#3ddc84" emissive="#3ddc84" emissiveIntensity={2} />
    </mesh>
  );
}

/// The sessions a server runs, floating over it. Starts at the corner; the
/// scene's frame loop moves it over its machine.
function Card({ ref, children }: { ref: Ref<HTMLDivElement>; children: ReactNode }) {
  return (
    <div
      ref={ref}
      className="pointer-events-none invisible absolute top-0 left-0 w-[248px] p-2"
    >
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  );
}

/// The orb while the session works, then the time it finished.
function Settling({ done, paused }: { done: boolean; paused?: boolean }) {
  return done ? <>now</> : <Orb paused={paused} />;
}
