// Hand-rolled rather than a dependency: one burst, one shape, no options. The
// smallest confetti package still ships a worker, an options schema and its own
// canvas manager for something that fits on a screen.

const COLORS = ["#10b981", "#38bdf8", "#f59e0b", "#f472b6", "#a78bfa"];
const COUNT = 44;
const GRAVITY = 0.28;
const DRAG = 0.985;
const FADE = 0.012;

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  vspin: number;
  size: number;
  color: string;
  life: number;
};

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let particles: Particle[] = [];
let frame = 0;

/// Throw a burst of paper from the centre of `from`, which can unmount the next
/// frame — the canvas lives on `document.body` and outlives whatever fired it.
export function burstConfetti(from: Element) {
  if (typeof window === "undefined") return;
  // Decoration with nothing to read in it, so reduced motion drops it outright
  // rather than shortening it.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const rect = from.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  for (let i = 0; i < COUNT; i++) {
    // An upward cone, not a full circle: half a circle's paper starts by going
    // down through the rows below, which reads as a spill rather than a burst.
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
    const speed = 4 + Math.random() * 5;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      spin: Math.random() * Math.PI,
      vspin: (Math.random() - 0.5) * 0.35,
      size: 4 + Math.random() * 4,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      life: 1,
    });
  }

  // Painted in the click's own frame rather than from the first `rAF`. Waiting
  // for the callback puts the burst a frame or two behind the button that fired
  // it, which is short enough to read as lag rather than as animation.
  ensureCanvas();
  draw();
  if (!frame) frame = requestAnimationFrame(tick);
}

/// Created and sized ahead of the first burst, and kept for the app's life — the
/// element insert, the backing-store allocation and the compositor's first
/// upload all land on the click otherwise, and they are what the first burst
/// stuttered on. Same bargain the celebration sound makes by decoding at load;
/// the cost is one window-sized buffer held while idle.
function ensureCanvas() {
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999";
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");
  }
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  // Assigning either dimension clears the canvas, so this is guarded rather
  // than run every frame — a burst mid-flight would blink otherwise.
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function warm() {
  if (typeof window === "undefined") return;
  const run = () => {
    ensureCanvas();
    if (!ctx) return;
    // A real fill, not a `clearRect`: the point is to make the compositor
    // allocate and upload the texture now, and clearing an untouched canvas is
    // free enough to be skipped entirely.
    ctx.fillStyle = "rgba(0,0,0,0.01)";
    ctx.fillRect(0, 0, 1, 1);
    ctx.clearRect(0, 0, 1, 1);
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(run);
  else setTimeout(run, 0);
}

warm();

function draw() {
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  for (const p of particles) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.spin);
    // Squashing the height by the spin is the whole flutter — a rectangle
    // turning edge-on is what reads as paper instead of as a dot.
    ctx.scale(1, Math.abs(Math.cos(p.spin)) * 0.8 + 0.2);
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
    ctx.restore();
  }
}

function tick() {
  frame = 0;
  if (!canvas || !ctx) return;
  ensureCanvas();

  const floor = window.innerHeight + 40;
  particles = particles.filter((p) => p.life > 0 && p.y < floor);
  for (const p of particles) {
    p.vx *= DRAG;
    p.vy = p.vy * DRAG + GRAVITY;
    p.x += p.vx;
    p.y += p.vy;
    p.spin += p.vspin;
    p.life -= FADE;
  }

  draw();
  if (particles.length > 0) frame = requestAnimationFrame(tick);
}
