/// The welcome sound's takes, made in code, to be picked by ear from the dev
/// switch. Each lands its moment at `at`, the time the logo's light passes;
/// a take that swells starts before it.
type Take = (ctx: AudioContext, out: AudioNode, hall: AudioNode, at: number) => void;

export const WELCOME_SOUNDS = [
  { id: "glow", label: "Glow", play: glow },
  { id: "felt", label: "Felt", play: felt },
  { id: "swell", label: "Swell", play: swell },
  { id: "air", label: "Air", play: air },
  { id: "none", label: "None", play: null },
] as const satisfies readonly { id: string; label: string; play: Take | null }[];
export type WelcomeSound = (typeof WELCOME_SOUNDS)[number]["id"];

/// Plays `id` with its moment `momentMs` from now.
export function playWelcomeSound(id: WelcomeSound, momentMs: number) {
  const take = WELCOME_SOUNDS.find((s) => s.id === id)?.play;
  if (!take) return;
  try {
    const ctx = new AudioContext();
    const master = ctx.createDynamicsCompressor();
    master.threshold.value = -20;
    master.ratio.value = 2.5;
    const out = ctx.createGain();
    out.gain.value = 0.5;
    master.connect(out).connect(ctx.destination);
    const hall = makeHall(ctx, 4);
    const wet = ctx.createGain();
    wet.gain.value = 0.45;
    hall.connect(wet).connect(master);
    const at = ctx.currentTime + Math.max(0.05, momentMs / 1000);
    take(ctx, master, hall, at);
    setTimeout(() => void ctx.close(), (at - ctx.currentTime + 9) * 1000);
  } catch {
    // No audio output.
  }
}

/// A slow warm chord that blooms in and fades: no attack at all.
function glow(ctx: AudioContext, out: AudioNode, hall: AudioNode, at: number) {
  const lp = filter(ctx, "lowpass", 1400);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, at - 0.4);
  env.gain.exponentialRampToValueAtTime(0.22, at + 0.6);
  env.gain.setValueAtTime(0.22, at + 1.4);
  env.gain.exponentialRampToValueAtTime(0.0001, at + 4.5);
  lp.connect(env);
  env.connect(out);
  env.connect(hall);
  // D major 9, open voicing.
  for (const hz of [146.83, 220, 329.63, 369.99, 440]) {
    for (const [type, cents] of [
      ["sine", 0],
      ["triangle", 6],
    ] as const) {
      voice(ctx, lp, hz, type, cents, at - 0.4, at + 4.6, 0.25);
    }
  }
}

/// A soft felt-piano roll up a chord, each note plucked and ringing out.
function felt(ctx: AudioContext, out: AudioNode, hall: AudioNode, at: number) {
  const lp = filter(ctx, "lowpass", 2200);
  lp.connect(out);
  lp.connect(hall);
  [293.66, 440, 554.37, 739.99].forEach((hz, i) => {
    const t = at + i * 0.07;
    for (const [mult, level] of [
      [1, 0.2],
      [2, 0.05],
      [3, 0.015],
    ]) {
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(level, t + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 3.2 - i * 0.3);
      env.connect(lp);
      voice(ctx, env, hz * mult, "triangle", 0, t, t + 3.3, 1);
    }
  });
}

/// Air rising into a soft open fifth, with a low hum under it instead of a boom.
function swell(ctx: AudioContext, out: AudioNode, hall: AudioNode, at: number) {
  const start = at - 1;
  const band = filter(ctx, "bandpass", 300);
  band.Q.value = 0.8;
  band.frequency.setValueAtTime(300, start);
  band.frequency.exponentialRampToValueAtTime(2800, at);
  const rise = ctx.createGain();
  rise.gain.setValueAtTime(0.0001, start);
  rise.gain.exponentialRampToValueAtTime(0.07, at);
  rise.gain.exponentialRampToValueAtTime(0.0001, at + 1.2);
  noise(ctx, start, at + 1.3).connect(band).connect(rise);
  rise.connect(hall);

  const lp = filter(ctx, "lowpass", 300);
  lp.frequency.setValueAtTime(300, at);
  lp.frequency.exponentialRampToValueAtTime(1800, at + 1);
  lp.frequency.exponentialRampToValueAtTime(600, at + 4.5);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, at - 0.05);
  env.gain.exponentialRampToValueAtTime(0.16, at + 0.35);
  env.gain.exponentialRampToValueAtTime(0.0001, at + 4.8);
  lp.connect(env);
  env.connect(out);
  env.connect(hall);
  for (const hz of [73.42, 146.83, 220, 293.66]) {
    for (const cents of [-6, 6]) voice(ctx, lp, hz, "sawtooth", cents, at - 0.05, at + 5, 0.12);
  }
}

/// Only shimmer: high soft sines drifting in like light on glass.
function air(ctx: AudioContext, _out: AudioNode, hall: AudioNode, at: number) {
  [880, 1174.66, 1318.51, 1760].forEach((hz, i) => {
    const t = at - 0.2 + i * 0.12;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.05, t + 0.5);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 3);
    env.connect(hall);
    voice(ctx, env, hz, "sine", 0, t, t + 3.1, 1);
  });
}

function voice(ctx: AudioContext, to: AudioNode, hz: number, type: OscillatorType, cents: number, from: number, until: number, level: number) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = hz;
  osc.detune.value = cents;
  const g = ctx.createGain();
  g.gain.value = level;
  osc.connect(g).connect(to);
  osc.start(Math.max(ctx.currentTime, from));
  osc.stop(until);
}

function filter(ctx: AudioContext, type: BiquadFilterType, hz: number) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  return f;
}

function noise(ctx: AudioContext, from: number, until: number) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * Math.max(0.1, until - from), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.start(Math.max(ctx.currentTime, from));
  return src;
}

/// Decaying noise as an impulse: a large soft room.
function makeHall(ctx: AudioContext, seconds: number) {
  const hall = ctx.createConvolver();
  const impulse = ctx.createBuffer(2, ctx.sampleRate * seconds, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
  }
  hall.buffer = impulse;
  return hall;
}
