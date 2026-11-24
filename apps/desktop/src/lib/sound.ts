import startUrl from "@/assets/dictate-start.wav";
import stopUrl from "@/assets/dictate-stop.wav";

const clips = new Map<string, HTMLAudioElement>();

/// Plays a clip from the top, and never lets a failure reach the caller.
///
/// Elements are kept and rewound rather than rebuilt per play: a fresh `Audio`
/// decodes on first play, which puts the tone a beat behind what it confirms.
/// Rewinding also restarts a tone still playing, which `play()` alone ignores.
/// `catch` is required, not defensive — `play()` rejects under an autoplay
/// policy, and nothing here is a reason to stop what the sound announces.
function play(url: string, volume = 1) {
  try {
    let clip = clips.get(url);
    if (!clip) {
      clip = new Audio(url);
      clip.volume = volume;
      clips.set(url, clip);
    }
    clip.currentTime = 0;
    void clip.play().catch(() => {});
  } catch {
    // No audio output, a codec the webview will not take, a headless test.
  }
}

// Fetched and decoded while the app is idle instead of on the first settle.
for (const url of ["/celebration.wav", "/notification.wav"]) {
  const clip = new Audio(url);
  clip.preload = "auto";
  clips.set(url, clip);
}

export function playCelebration() {
  play("/celebration.wav");
}

/// The in-app half of a session handing itself back to the reader.
///
/// Paired with the sidebar glow rather than replacing it: the glow is at the
/// edge of vision and easy to miss while reading something else, and the sound
/// carries with the eyes anywhere on screen. Silent when the window is in the
/// background, since the desktop notification makes its own noise there.
export function playNotification() {
  play("/notification.wav");
}

/// The two ends of a dictation: Handy's own marimba pair (MIT, see
/// THIRD-PARTY-LICENSES.md), the second tone answering the first.
///
/// `stop` plays when the words land, not when the microphone closes — the gap
/// between the two is the whole wait. Cancel is silent, as in Handy. Volume is
/// fixed: feedback for a press should sit under the room, not over it.
export function playDictationSound(sound: "start" | "stop") {
  play(sound === "start" ? startUrl : stopUrl, 0.35);
}

/// Onboarding's welcome, a studio-logo intro made in code: a breathy riser
/// swells for `hitInMs`, then a sub boom and a wide D major chord bloom open
/// and ring out in a long hall. The hit is what lines up with the moment on
/// screen, so the riser starts that long before it.
export function playWelcome(hitInMs = 1100) {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime + 0.03;
    const hit = now + Math.max(0.4, hitInMs / 1000);

    const master = ctx.createDynamicsCompressor();
    master.threshold.value = -18;
    master.ratio.value = 3;
    const out = ctx.createGain();
    out.gain.value = 0.5;
    master.connect(out).connect(ctx.destination);

    // A hall made of decaying noise: what turns a dry synth into a big room.
    const hall = ctx.createConvolver();
    const seconds = 4.5;
    const impulse = ctx.createBuffer(2, ctx.sampleRate * seconds, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2.6);
    }
    hall.buffer = impulse;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    hall.connect(wet).connect(master);

    // Riser: noise through a band that climbs, swelling into the hit.
    const noise = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const n = noise.getChannelData(0);
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
    const air = ctx.createBufferSource();
    air.buffer = noise;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 1.2;
    band.frequency.setValueAtTime(250, now);
    band.frequency.exponentialRampToValueAtTime(3500, hit);
    const swell = ctx.createGain();
    swell.gain.setValueAtTime(0.0001, now);
    swell.gain.exponentialRampToValueAtTime(0.16, hit - 0.02);
    swell.gain.exponentialRampToValueAtTime(0.0001, hit + 0.5);
    air.connect(band).connect(swell);
    swell.connect(master);
    swell.connect(hall);
    air.start(now);
    air.stop(hit + 0.6);

    // Boom: a sine falling from 90Hz to 40Hz, felt more than heard.
    const sub = ctx.createOscillator();
    sub.frequency.setValueAtTime(90, hit);
    sub.frequency.exponentialRampToValueAtTime(40, hit + 1.2);
    const thump = ctx.createGain();
    thump.gain.setValueAtTime(0.0001, hit);
    thump.gain.exponentialRampToValueAtTime(0.9, hit + 0.02);
    thump.gain.exponentialRampToValueAtTime(0.0001, hit + 2.6);
    sub.connect(thump).connect(master);
    sub.start(hit);
    sub.stop(hit + 2.7);

    // The chord: D major add 9 spread over three octaves, two detuned saws a
    // note, behind a filter that opens on the hit and slowly closes again.
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.Q.value = 0.7;
    tone.frequency.setValueAtTime(220, hit);
    tone.frequency.exponentialRampToValueAtTime(2600, hit + 0.9);
    tone.frequency.exponentialRampToValueAtTime(500, hit + 4.5);
    const pad = ctx.createGain();
    pad.gain.setValueAtTime(0.0001, hit);
    pad.gain.exponentialRampToValueAtTime(0.07, hit + 0.12);
    pad.gain.setValueAtTime(0.07, hit + 0.8);
    pad.gain.exponentialRampToValueAtTime(0.0001, hit + 5);
    tone.connect(pad);
    pad.connect(master);
    pad.connect(hall);
    for (const hz of [73.42, 110, 146.83, 185, 220, 329.63, 440]) {
      for (const cents of [-8, 8]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = hz;
        osc.detune.value = cents;
        osc.connect(tone);
        osc.start(hit);
        osc.stop(hit + 5.1);
      }
    }

    // Shimmer: soft high sines that fade in late, into the hall only.
    for (const hz of [587.33, 880, 1174.66]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = hz;
      const glow = ctx.createGain();
      glow.gain.setValueAtTime(0.0001, hit + 0.2);
      glow.gain.exponentialRampToValueAtTime(0.03, hit + 1.4);
      glow.gain.exponentialRampToValueAtTime(0.0001, hit + 5);
      osc.connect(glow).connect(hall);
      osc.start(hit + 0.2);
      osc.stop(hit + 5.1);
    }

    setTimeout(() => void ctx.close(), (hit - now + 10) * 1000);
  } catch {
    // No audio output.
  }
}
