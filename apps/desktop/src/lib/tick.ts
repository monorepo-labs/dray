/// The click a sidebar swipe makes as it steps past each project, made in code
/// rather than shipped as a file: a click is a few milliseconds of shaped
/// noise, cheap to synthesize, and nothing to license. The candidates it was
/// picked from live on `demo/swipe-tick.html`, built from these same parts.
///
/// Synthesized offline and played through `<audio>`, never a live
/// `AudioContext`: WebKit holds a live context suspended until a click or key
/// press, and a trackpad swipe is neither, so most ticks were silent and the
/// odd one came through after the reader happened to click something. Media
/// elements are what `sound.ts` plays through, and the webview lets them play.

export type Voice = (ctx: BaseAudioContext, out: AudioNode, at: number) => void;

const RATE = 44100;
const LENGTH_S = 0.06;

const noises = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseFor(c: BaseAudioContext) {
  let buf = noises.get(c);
  if (!buf) {
    buf = c.createBuffer(1, Math.ceil(c.sampleRate * 0.05), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noises.set(c, buf);
  }
  return buf;
}

/// A burst of noise through a filter, falling away over `decay` seconds.
export function burst(c: BaseAudioContext, out: AudioNode, at: number, type: BiquadFilterType, freq: number, q: number, gain: number, decay: number) {
  const src = c.createBufferSource();
  src.buffer = noiseFor(c);
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const env = c.createGain();
  env.gain.setValueAtTime(gain, at);
  env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  src.connect(filter).connect(env).connect(out);
  src.start(at);
  src.stop(at + decay + 0.01);
}

/// A tone that drops from `from` to `to` Hz while it dies away.
export function ping(c: BaseAudioContext, out: AudioNode, at: number, type: OscillatorType, from: number, to: number, gain: number, decay: number) {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + decay);
  const env = c.createGain();
  env.gain.setValueAtTime(gain, at);
  env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(at + decay + 0.01);
}

/// The iPod's scroll wheel: tiny, sharp and very high. Picked by ear over a
/// picker tick, a ratchet, wood, and steel-ringing variants of itself.
export const clickWheel: Voice = (c, out, at) => burst(c, out, at, "highpass", 5000, 0.8, 0.8, 0.005);

/// 16-bit mono PCM, the one format every `<audio>` takes.
function wav(samples: Float32Array, rate: number) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return view.buffer;
}

async function render(voice: Voice) {
  const c = new OfflineAudioContext(1, Math.ceil(RATE * LENGTH_S), RATE);
  voice(c, c.destination, 0);
  const buf = await c.startRendering();
  return URL.createObjectURL(new Blob([wav(buf.getChannelData(0), RATE)], { type: "audio/wav" }));
}

/// Several elements per voice, taken in turn: a fast drag ticks faster than a
/// 60ms clip ends, and rewinding the one element would cut each tick short.
const POOL = 4;
const pools = new Map<Voice, Promise<HTMLAudioElement[]>>();
let turn = 0;

function pool(voice: Voice) {
  let p = pools.get(voice);
  if (!p) {
    p = render(voice).then((url) =>
      Array.from({ length: POOL }, () => {
        const el = new Audio(url);
        el.preload = "auto";
        return el;
      }),
    );
    // A failed render is tried again next time rather than cached.
    p.catch(() => pools.delete(voice));
    pools.set(voice, p);
  }
  return p;
}

/// Plays one click. Never throws: no audio output is not a reason to stop a
/// swipe.
export function playVoice(voice: Voice, volume = 0.5) {
  pool(voice)
    .then((els) => {
      const el = els[turn++ % els.length];
      el.volume = volume;
      el.currentTime = 0;
      void el.play().catch(() => {});
    })
    .catch(() => {});
}

export const playSwipeTick = () => playVoice(clickWheel);

// Rendered at load, so the first swipe's first tick is not a render behind.
if (typeof OfflineAudioContext !== "undefined") void pool(clickWheel).catch(() => {});
