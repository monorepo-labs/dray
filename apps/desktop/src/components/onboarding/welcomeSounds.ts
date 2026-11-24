/// Onboarding's sounds, made in code: a shimmer under the logo's light, then a
/// looping game-start groove from the welcome line on. Picked by ear (#1421)
/// from takes that live in this file's history.
///
/// Every voice stays above ~140Hz or leans on harmonics, since a laptop's
/// speakers drop anything lower.

/// High soft sines drifting in like light on glass, landing as the logo's
/// light passes, `momentMs` from now.
export function playWelcomeSound(momentMs: number) {
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
    [880, 1174.66, 1318.51, 1760].forEach((hz, i) => {
      const t = at - 0.2 + i * 0.12;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.05, t + 0.5);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 3);
      env.connect(hall);
      voice(ctx, env, hz, "sine", 0, t, t + 3.1, 1);
    });
    setTimeout(() => void ctx.close(), (at - ctx.currentTime + 9) * 1000);
  } catch {
    // No audio output.
  }
}

function voice(ctx: BaseAudioContext, to: AudioNode, hz: number, type: OscillatorType, cents: number, from: number, until: number, level: number) {
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

function filter(ctx: BaseAudioContext, type: BiquadFilterType, hz: number) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  return f;
}

const BPM = 124;
const SIXTEENTH = 60 / BPM / 4;
// D A Bm G, a bar each.
const CHORDS = [
  [293.66, 369.99, 440, 587.33],
  [277.18, 329.63, 440, 554.37],
  [293.66, 369.99, 493.88, 587.33],
  [293.66, 392, 493.88, 587.33],
];
const ROOTS = [146.83, 110, 123.47, 98];
const ARP = [0, 1, 2, 3, 1, 2, 3, 2];
// The hook, in eighths; 0 rests.
const LEAD = [
  [880, 0, 739.99, 880, 1174.66, 0, 880, 0],
  [1108.73, 0, 880, 659.25, 880, 0, 1108.73, 0],
  [987.77, 0, 739.99, 987.77, 1174.66, 0, 1108.73, 987.77],
  [880, 0, 783.99, 0, 987.77, 0, 880, 0],
];

const MUSIC_LEVEL = 0.35;
/// The music's share of its level while the welcome voice speaks over it.
const UNDER_VOICE = 0.7;
/// How long the music takes to fade once onboarding ends.
const MUSIC_FADE_S = 4;
const LOOP_STEPS = 64;
const RATE = 48000;

/// Onboarding's music after the logo: an intro bar of arpeggio alone, then a
/// four-bar loop with drums, bass and the hook. It starts low, under the voice,
/// until `lift` brings it up; `stop` fades it out slowly.
///
/// Rendered ahead into buffers and looped by the audio engine itself: notes
/// paced by a timer stalled whenever the window went to the background, which
/// throttles timers, and the music stopped and started with every app switch.
export function startOnboardingMusic(): { lift: () => void; stop: () => void } {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return { lift: () => {}, stop: () => {} };
  }
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, ctx.currentTime);
  master.connect(ctx.destination);
  let stopped = false;
  let lifted = false;

  // The first pass: the intro bar and one whole loop, cut at the loop's end;
  // the loop that follows carries that last bar's tail at its own start.
  void Promise.all([renderSteps(0, 16 + LOOP_STEPS, 0), renderLoop()])
    .then(([first, loop]) => {
      if (stopped) return;
      const at = ctx.currentTime + 0.05;
      master.gain.setValueAtTime(0.0001, at);
      master.gain.exponentialRampToValueAtTime(lifted ? MUSIC_LEVEL : MUSIC_LEVEL * UNDER_VOICE, at + 0.6);
      const head = ctx.createBufferSource();
      head.buffer = first;
      head.connect(master);
      head.start(at);
      const rest = ctx.createBufferSource();
      rest.buffer = loop;
      rest.loop = true;
      rest.connect(master);
      rest.start(at + first.duration);
    })
    .catch(() => {});

  const lift = () => {
    if (stopped) return;
    lifted = true;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(MUSIC_LEVEL, now + 1.5);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + MUSIC_FADE_S);
    setTimeout(() => void ctx.close(), (MUSIC_FADE_S + 0.3) * 1000);
  };
  return { lift, stop };
}

/// The loop alone, its tail folded back onto its start so it repeats seamlessly.
async function renderLoop(): Promise<AudioBuffer> {
  const raw = await renderSteps(16, 16 + LOOP_STEPS, 3);
  const len = Math.round(LOOP_STEPS * SIXTEENTH * RATE);
  const out = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: RATE });
  for (let ch = 0; ch < 2; ch++) {
    const src = raw.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.subarray(0, len));
    for (let i = len; i < src.length; i++) dst[i - len] += src[i];
  }
  return out;
}

/// Renders steps `from` to `to` (sixteenths, counted from the intro's first),
/// with `tail` seconds after the last for it to ring out.
function renderSteps(from: number, to: number, tail: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.round(((to - from) * SIXTEENTH + tail) * RATE), RATE);
  const master = ctx.createDynamicsCompressor();
  master.threshold.value = -18;
  master.ratio.value = 3;
  master.connect(ctx.destination);
  const hall = makeHall(ctx, 2.5);
  const wet = ctx.createGain();
  wet.gain.value = 0.18;
  hall.connect(wet).connect(master);

  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const send = (from: AudioNode, amount: number) => {
    if (!amount) return;
    const s = ctx.createGain();
    s.gain.value = amount;
    from.connect(s).connect(hall);
  };
  const pluck = (hz: number, t: number, type: OscillatorType, level: number, decay: number, cutoff: number, amount = 0) => {
    const lp = filter(ctx, "lowpass", cutoff);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(level, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    lp.connect(env).connect(master);
    send(env, amount);
    voice(ctx, lp, hz, type, 0, t, t + decay + 0.02, 1);
  };
  const hit = (t: number, type: BiquadFilterType, hz: number, level: number, decay: number) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = filter(ctx, type, hz);
    const env = ctx.createGain();
    env.gain.setValueAtTime(level, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(f).connect(env).connect(master);
    src.start(t);
    src.stop(t + decay + 0.02);
  };
  const kick = (t: number) => {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.9, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(env).connect(master);
    osc.start(t);
    osc.stop(t + 0.3);
    hit(t, "highpass", 3000, 0.25, 0.015);
  };

  for (let n = from; n < to; n++) {
    const t = (n - from) * SIXTEENTH;
    // The intro bar sits on the loop's last chord, so the drums land on D.
    const s = (n - 16 + LOOP_STEPS) % LOOP_STEPS;
    const bar = Math.floor(s / 16);
    const i = s % 16;
    pluck(CHORDS[bar][ARP[i % 8]] * (i >= 8 ? 2 : 1), t, "triangle", 0.07, 0.2, 5000, 0.4);
    if (n < 16) continue;
    if (i % 4 === 0) kick(t);
    if (i % 4 === 2) hit(t, "highpass", 7000, 0.12, 0.05);
    if (i === 4 || i === 12) hit(t, "bandpass", 1600, 0.35, 0.14);
    if (i % 2 === 0) pluck(ROOTS[bar] * (i % 4 === 2 ? 2 : 1), t, "sawtooth", 0.14, 0.16, 1100);
    const note = i % 2 === 0 ? LEAD[bar][i / 2] : 0;
    if (note) pluck(note, t, "square", 0.045, 0.22, 3200, 0.5);
  }
  return ctx.startRendering();
}

/// Decaying noise as an impulse: a large soft room.
function makeHall(ctx: BaseAudioContext, seconds: number) {
  const hall = ctx.createConvolver();
  const impulse = ctx.createBuffer(2, ctx.sampleRate * seconds, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
  }
  hall.buffer = impulse;
  return hall;
}
