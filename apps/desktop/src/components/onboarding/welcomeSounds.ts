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
  rise.gain.exponentialRampToValueAtTime(0.1, at);
  rise.gain.exponentialRampToValueAtTime(0.0001, at + 1.2);
  noise(ctx, start, at + 1.3).connect(band).connect(rise);
  rise.connect(out);
  rise.connect(hall);

  // Kept above 140Hz: a laptop's speakers play nothing much lower, and the
  // first take of this lived down there and came out silent.
  const lp = filter(ctx, "lowpass", 600);
  lp.frequency.setValueAtTime(600, at);
  lp.frequency.exponentialRampToValueAtTime(2600, at + 1);
  lp.frequency.exponentialRampToValueAtTime(900, at + 4.5);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, at - 0.05);
  env.gain.exponentialRampToValueAtTime(0.2, at + 0.35);
  env.gain.exponentialRampToValueAtTime(0.0001, at + 4.8);
  lp.connect(env);
  env.connect(out);
  env.connect(hall);
  for (const hz of [146.83, 220, 293.66, 369.99, 440]) {
    for (const cents of [-6, 6]) voice(ctx, lp, hz, "sawtooth", cents, at - 0.05, at + 5, 0.16);
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

function noise(ctx: AudioContext, from: number, until: number) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * Math.max(0.1, until - from), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.start(Math.max(ctx.currentTime, from));
  return src;
}

/// The voices a track plays its steps with, on one render.
type Kit = {
  pluck: (hz: number, t: number, type: OscillatorType, level: number, decay: number, cutoff: number, send?: number) => void;
  hit: (t: number, type: BiquadFilterType, hz: number, level: number, decay: number, send?: number) => void;
  kick: (t: number, level?: number) => void;
};
/// One sixteenth: `bar` and `i` place it in the four-bar loop; `intro` is the
/// first bar, before the loop, which plays under the voice's opening.
type Step = { intro: boolean; bar: number; i: number };
/// `gain` evens a track out against Arcade, measured off their renders.
type Track = { bpm: number; gain?: number; play: (k: Kit, s: Step, t: number) => void };

/// One track in Arcade's mould: a triangle arpeggio climbing an octave halfway
/// through each bar, four on the floor, an octave-pumping saw bass and a
/// square-wave hook in eighths (0 rests). `sparkle` rings a high bell on each
/// bar's first beat; `openHat` lets the off-beat hat ring longer.
function arcade(spec: {
  bpm: number;
  gain?: number;
  chords: number[][];
  roots: number[];
  lead: number[][];
  arp?: number[];
  leadDecay?: number;
  sparkle?: boolean;
  openHat?: boolean;
}): Track {
  const arp = spec.arp ?? [0, 1, 2, 3, 1, 2, 3, 2];
  return {
    bpm: spec.bpm,
    gain: spec.gain,
    play(k, { intro, bar, i }, t) {
      const chord = spec.chords[bar];
      k.pluck(chord[arp[i % 8]] * (i >= 8 ? 2 : 1), t, "triangle", 0.07, 0.2, 5000, 0.4);
      if (spec.sparkle && i === 0) k.pluck(chord[3] * 4, t, "sine", 0.025, 1.2, 9000, 0.8);
      if (intro) return;
      if (i % 4 === 0) k.kick(t);
      if (i % 4 === 2) k.hit(t, "highpass", 7000, spec.openHat ? 0.1 : 0.12, spec.openHat ? 0.14 : 0.05);
      if (i === 4 || i === 12) k.hit(t, "bandpass", 1600, 0.35, 0.14);
      if (i % 2 === 0) k.pluck(spec.roots[bar] * (i % 4 === 2 ? 2 : 1), t, "sawtooth", 0.14, 0.16, 1100);
      const note = i % 2 === 0 ? spec.lead[bar][i / 2] : 0;
      if (note) k.pluck(note, t, "square", 0.045, spec.leadDecay ?? 0.22, 3200, 0.5);
    },
  };
}

// Every voice stays above ~140Hz or leans on harmonics, since a laptop's
// speakers drop anything lower.

/// The first one. D A Bm G.
const ARCADE = arcade({
  bpm: 124,
  chords: [
    [293.66, 369.99, 440, 587.33],
    [277.18, 329.63, 440, 554.37],
    [293.66, 369.99, 493.88, 587.33],
    [293.66, 392, 493.88, 587.33],
  ],
  roots: [146.83, 110, 123.47, 98],
  lead: [
    [880, 0, 739.99, 880, 1174.66, 0, 880, 0],
    [1108.73, 0, 880, 659.25, 880, 0, 1108.73, 0],
    [987.77, 0, 739.99, 987.77, 1174.66, 0, 1108.73, 987.77],
    [880, 0, 783.99, 0, 987.77, 0, 880, 0],
  ],
});

/// Brighter and a touch quicker, the hook up high, a bell on each bar. E B C#m A.
const LEVEL_UP = arcade({
  bpm: 128,
  sparkle: true,
  arp: [0, 2, 1, 3, 0, 2, 1, 3],
  chords: [
    [329.63, 415.3, 493.88, 659.25],
    [311.13, 369.99, 493.88, 622.25],
    [277.18, 329.63, 415.3, 554.37],
    [277.18, 329.63, 440, 554.37],
  ],
  roots: [164.81, 123.47, 138.59, 110],
  lead: [
    [1318.51, 0, 987.77, 0, 1318.51, 1479.98, 1318.51, 0],
    [1244.51, 0, 987.77, 0, 1244.51, 1318.51, 1244.51, 0],
    [1108.73, 0, 830.61, 0, 1108.73, 1244.51, 1108.73, 987.77],
    [880, 0, 1108.73, 0, 1318.51, 0, 1479.98, 0],
  ],
});

/// The fastest: a busy bouncing hook and an open hat. F Dm Bb C.
const BONUS_ROUND = arcade({
  bpm: 132,
  openHat: true,
  leadDecay: 0.16,
  chords: [
    [349.23, 440, 523.25, 698.46],
    [293.66, 349.23, 440, 587.33],
    [293.66, 349.23, 466.16, 587.33],
    [329.63, 392, 523.25, 659.25],
  ],
  roots: [174.61, 146.83, 116.54, 130.81],
  lead: [
    [1046.5, 880, 698.46, 880, 1046.5, 0, 1396.91, 0],
    [1174.66, 880, 698.46, 880, 1174.66, 0, 1046.5, 0],
    [1174.66, 932.33, 698.46, 932.33, 1174.66, 0, 1396.91, 0],
    [1318.51, 0, 1046.5, 0, 1567.98, 0, 1318.51, 0],
  ],
});

/// The anthem: a slower, singing hook with held notes, and the bell. C D Bm Em.
const HIGH_SCORE = arcade({
  bpm: 118,
  sparkle: true,
  leadDecay: 0.45,
  chords: [
    [261.63, 329.63, 392, 523.25],
    [293.66, 369.99, 440, 587.33],
    [246.94, 293.66, 369.99, 493.88],
    [246.94, 329.63, 392, 493.88],
  ],
  roots: [130.81, 146.83, 123.47, 164.81],
  lead: [
    [783.99, 0, 0, 880, 987.77, 0, 880, 0],
    [880, 0, 0, 987.77, 1174.66, 0, 987.77, 0],
    [987.77, 0, 0, 880, 739.99, 0, 783.99, 0],
    [659.25, 0, 0, 739.99, 783.99, 0, 987.77, 0],
  ],
});

export const MUSIC_TRACKS = [
  { id: "arcade", label: "Arcade", track: ARCADE },
  { id: "levelup", label: "Level up", track: LEVEL_UP },
  { id: "bonus", label: "Bonus round", track: BONUS_ROUND },
  { id: "highscore", label: "High score", track: HIGH_SCORE },
] as const;
export type MusicTrack = (typeof MUSIC_TRACKS)[number]["id"];

const MUSIC_LEVEL = 0.35;
/// The music's share of its level while the welcome voice speaks over it.
const UNDER_VOICE = 0.7;
/// How long the music takes to fade once onboarding ends.
const MUSIC_FADE_S = 4;
const LOOP_STEPS = 64;
const RATE = 48000;

/// Onboarding's music after the logo, one of `MUSIC_TRACKS`: an intro bar,
/// then the four-bar loop. It starts low, under the voice, until `lift` brings
/// it up, or at full level when `lifted`; `stop` fades it out slowly.
///
/// Rendered ahead into buffers and looped by the audio engine itself: notes
/// paced by a timer stalled whenever the window went to the background, which
/// throttles timers, and the music stopped and started with every app switch.
export function startOnboardingMusic(
  id: MusicTrack,
  lifted = false,
): { lift: () => void; stop: (fadeSeconds?: number) => void } {
  const track = MUSIC_TRACKS.find((m) => m.id === id)?.track ?? ARCADE;
  const level = MUSIC_LEVEL * (track.gain ?? 1);
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

  // The first pass: the intro bar and one whole loop, cut at the loop's end;
  // the loop that follows carries that last bar's tail at its own start.
  void Promise.all([renderSteps(track, 0, 16 + LOOP_STEPS, 0), renderLoop(track)])
    .then(([first, loop]) => {
      if (stopped) return;
      const at = ctx.currentTime + 0.05;
      master.gain.setValueAtTime(0.0001, at);
      master.gain.exponentialRampToValueAtTime(lifted ? level : level * UNDER_VOICE, at + 0.6);
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
    master.gain.linearRampToValueAtTime(level, now + 1.5);
  };
  const stop = (fade = MUSIC_FADE_S) => {
    if (stopped) return;
    stopped = true;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + fade);
    setTimeout(() => void ctx.close(), (fade + 0.3) * 1000);
  };
  return { lift, stop };
}

const sixteenth = (track: Track) => 60 / track.bpm / 4;

/// The loop alone, its tail folded back onto its start so it repeats seamlessly.
async function renderLoop(track: Track): Promise<AudioBuffer> {
  const raw = await renderSteps(track, 16, 16 + LOOP_STEPS, 3);
  const len = Math.round(LOOP_STEPS * sixteenth(track) * RATE);
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
function renderSteps(track: Track, from: number, to: number, tail: number): Promise<AudioBuffer> {
  const step = sixteenth(track);
  const ctx = new OfflineAudioContext(2, Math.round(((to - from) * step + tail) * RATE), RATE);
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
  const kit: Kit = {
    pluck(hz, t, type, level, decay, cutoff, amount = 0) {
      const lp = filter(ctx, "lowpass", cutoff);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(level, t + 0.005);
      env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      lp.connect(env).connect(master);
      send(env, amount);
      voice(ctx, lp, hz, type, 0, t, t + decay + 0.02, 1);
    },
    hit(t, type, hz, level, decay, amount = 0) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const f = filter(ctx, type, hz);
      const env = ctx.createGain();
      env.gain.setValueAtTime(level, t);
      env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      src.connect(f).connect(env).connect(master);
      send(env, amount);
      src.start(t);
      src.stop(t + decay + 0.02);
    },
    kick(t, level = 0.9) {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(180, t);
      osc.frequency.exponentialRampToValueAtTime(50, t + 0.12);
      const env = ctx.createGain();
      env.gain.setValueAtTime(level, t);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(env).connect(master);
      osc.start(t);
      osc.stop(t + 0.3);
      kit.hit(t, "highpass", 3000, level * 0.28, 0.015);
    },
  };

  for (let n = from; n < to; n++) {
    const s = (n - 16 + LOOP_STEPS) % LOOP_STEPS;
    track.play(kit, { intro: n < 16, bar: Math.floor(s / 16), i: s % 16 }, (n - from) * step);
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
