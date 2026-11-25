/// Onboarding's sounds: a shimmer under the logo's light, made in code, then
/// a recorded song from the welcome line on (#1567). The shimmer was picked by
/// ear (#1421) from takes that live in this file's history, as does the synth
/// groove the song replaced.
///
/// Every voice stays above ~140Hz or leans on harmonics, since a laptop's
/// speakers drop anything lower.

import musicUrl from "@/assets/onboarding-music.mp3";

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

/// Brings the song to the level the synth it replaced played at: -18.4dB
/// gated RMS against the synth's -29dB.
const MUSIC_LEVEL = 0.3;
/// How long the music takes to fade once onboarding ends.
const MUSIC_FADE_S = 4;

/// Onboarding's song, "Welcome to Dray", starting `delayMs` from now and
/// played once: it has its own build-in and ending, so nothing fades it but
/// `stop`. Never looped, since a reader still installing an agent sits on
/// setup for minutes.
///
/// Decoded into a buffer and scheduled on the audio clock rather than played
/// by an `<audio>`: the fade on `stop` must run while the window is in the
/// background, where timers are throttled.
export function startOnboardingMusic(delayMs: number): { stop: () => void } {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return { stop: () => {} };
  }
  const due = ctx.currentTime + delayMs / 1000;
  const close = () => void ctx.close().catch(() => {});
  const master = ctx.createGain();
  master.gain.value = MUSIC_LEVEL;
  master.connect(ctx.destination);
  let stopped = false;

  void fetch(musicUrl)
    .then((res) => res.arrayBuffer())
    .then((bytes) => ctx.decodeAudioData(bytes))
    .then((music) => {
      if (stopped) return;
      const src = ctx.createBufferSource();
      src.buffer = music;
      src.connect(master);
      src.onended = close;
      src.start(Math.max(due, ctx.currentTime + 0.05));
    })
    .catch(close);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + MUSIC_FADE_S);
    setTimeout(close, (MUSIC_FADE_S + 0.3) * 1000);
  };
  return { stop };
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
