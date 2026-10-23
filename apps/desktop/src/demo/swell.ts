/// The sound engine the send and dictation auditions share, so a tone on one
/// page is the same numbers on the other.

export type Voice = (c: AudioContext, out: AudioNode, at: number) => void;

/// Messages' gesture, with its parts as knobs: quiet in over `swell`, a glide
/// from `from` to `to` starting at `glideAt`, then a fade over `fade`, where
/// `settle` is the pitch it eases back to as it goes. Each voice is a pitch
/// ratio, a level and a detune in cents. A `to` below `from` falls.
export type Swell = {
  from: number;
  to: number;
  settle?: number;
  swell: number;
  glideAt: number;
  glide: number;
  fade: number;
  voices: [number, number, number][];
};

/// The send's timbre: two equal tones 8 cents either side of the pitch.
export const SHIMMER: [number, number, number][] = [
  [1, 0.4, -8],
  [1, 0.4, 8],
];

export function swell(c: AudioContext, out: AudioNode, at: number, p: Swell) {
  const peak = at + p.swell;
  const end = peak + p.fade;
  const g = c.createGain();
  g.gain.setValueAtTime(0.02, at);
  g.gain.exponentialRampToValueAtTime(1, peak);
  g.gain.exponentialRampToValueAtTime(0.02, end);
  g.gain.linearRampToValueAtTime(0, end + 0.03);
  g.connect(out);
  for (const [ratio, level, cents] of p.voices) {
    const osc = c.createOscillator();
    osc.detune.value = cents;
    osc.frequency.setValueAtTime(p.from * ratio, at);
    osc.frequency.setValueAtTime(p.from * ratio, at + p.glideAt);
    osc.frequency.exponentialRampToValueAtTime(p.to * ratio, at + p.glideAt + p.glide);
    if (p.settle) osc.frequency.exponentialRampToValueAtTime(p.settle * ratio, end);
    const gain = c.createGain();
    gain.gain.value = level;
    osc.connect(gain).connect(g);
    osc.start(at);
    osc.stop(end + 0.05);
  }
}

/// A recorded file, at the page's volume.
export const file =
  (url: string): Voice =>
  (c, out, at) => {
    void fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => c.decodeAudioData(b))
      .then((buf) => {
        const src = c.createBufferSource();
        src.buffer = buf;
        src.connect(out);
        src.start(Math.max(at, c.currentTime));
      })
      .catch(() => {});
  };

let ctx: AudioContext | undefined;

/// Plays a voice at `volume`, `delay` seconds from now.
export function play(voice: Voice, volume: number, delay = 0) {
  // Made on the first press, which is what lets a browser start it.
  ctx ??= new AudioContext();
  const out = ctx.createGain();
  out.gain.value = volume;
  out.connect(ctx.destination);
  voice(ctx, out, ctx.currentTime + 0.01 + delay);
}
