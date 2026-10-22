import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";

import startUrl from "@/assets/dictate-start.wav";
import stopUrl from "@/assets/dictate-stop.wav";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { file, play, swell, type Voice } from "@/demo/swell";
import "../App.css";
import sendUrl from "../../../island/Island/send.wav?url";

/// A builder for dictation's start and stop sounds. Start only says the mic is
/// open; stop says the words landed. Each is a few notes in the send sound's
/// family — sines swelling in, optionally sliding into pitch, detuned for
/// shimmer, with an echo — and every knob is a slider. Releasing a slider
/// plays what it changed. The config persists in local storage, and Copy hands
/// over the JSON a picked sound gets rendered to a wav from. Judge in Safari,
/// the app's engine.
///
/// Nothing built here was picked: dictation kept Handy's marimba pair (2026-10-22).

type Sound = {
  /// Semitones above the root, one per note.
  notes: number[];
  gap: number;
  /// Semitones each note slides in from; negative comes up from below.
  scoop: number;
  scoopTime: number;
  attack: number;
  fade: number;
  lastFade: number;
  /// The last note sounds as a major triad.
  chord: boolean;
  /// Cents either side of the pitch; 0 is one plain sine.
  detune: number;
  octave: number;
  sub: number;
  echoTime: number;
  feedback: number;
  mix: number;
};

type Config = { root: number; volume: number; start: Sound; stop: Sound };

const BLOOM: Config = {
  root: 71,
  volume: 0.4,
  start: { notes: [7], gap: 0.07, scoop: -1, scoopTime: 0.04, attack: 0.035, fade: 0.12, lastFade: 0.12, chord: false, detune: 8, octave: 0.08, sub: 0, echoTime: 0.11, feedback: 0.3, mix: 0 },
  stop: { notes: [0, 7], gap: 0.07, scoop: 0, scoopTime: 0.03, attack: 0.02, fade: 0.08, lastFade: 0.22, chord: false, detune: 8, octave: 0.08, sub: 0, echoTime: 0.11, feedback: 0.3, mix: 0.35 },
};

const PRESETS: { name: string; config: Config }[] = [
  { name: "Bloom", config: BLOOM },
  {
    name: "Round",
    config: {
      ...BLOOM,
      root: 59,
      start: { ...BLOOM.start, attack: 0.05, scoopTime: 0.05, fade: 0.14, lastFade: 0.14, detune: 5, octave: 0, sub: 0.1 },
      stop: { ...BLOOM.stop, attack: 0.035, fade: 0.14, lastFade: 0.26, detune: 5, octave: 0, sub: 0.1, echoTime: 0.12, feedback: 0.25, mix: 0.3 },
    },
  },
  {
    name: "Felt",
    config: {
      ...BLOOM,
      root: 59,
      start: { ...BLOOM.start, attack: 0.06, scoopTime: 0.05, fade: 0.13, lastFade: 0.13, detune: 0, octave: 0 },
      stop: { ...BLOOM.stop, attack: 0.04, fade: 0.14, lastFade: 0.26, detune: 0, octave: 0, echoTime: 0.12, feedback: 0.25, mix: 0.3 },
    },
  },
];

const STORE = "ade.demo.dictationSound";

function load(): Config {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<Config> | null;
    if (!saved) return BLOOM;
    return { ...BLOOM, ...saved, start: { ...BLOOM.start, ...saved.start }, stop: { ...BLOOM.stop, ...saved.stop } };
  } catch {
    return BLOOM;
  }
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (midi: number) => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
const THIRD = 2 ** (4 / 12);
const FIFTH = 2 ** (7 / 12);

type Voices = [number, number, number][];

function voicesOf(s: Sound, chord: boolean): Voices {
  const base: Voices = s.detune ? [[1, 0.4, -s.detune], [1, 0.4, s.detune]] : [[1, 0.7, 0]];
  if (s.octave) base.push([2, s.octave, 0]);
  if (s.sub) base.push([0.5, s.sub, 0]);
  if (!chord) return base;
  // Each chord tone gets the whole timbre, the root louder than the rest.
  return [
    ...base.map(([r, l, c]): [number, number, number] => [r, l * 0.6, c]),
    ...base.map(([r, l, c]): [number, number, number] => [r * THIRD, l * 0.35, c]),
    ...base.map(([r, l, c]): [number, number, number] => [r * FIFTH, l * 0.3, c]),
  ];
}

/// A feedback echo in front of `out`; answers the node a sound should play into.
function echoInto(c: AudioContext, out: AudioNode, s: Sound): AudioNode {
  const dry = c.createGain();
  const delay = c.createDelay(1);
  const fb = c.createGain();
  const wet = c.createGain();
  delay.delayTime.value = s.echoTime;
  fb.gain.value = s.feedback;
  wet.gain.value = s.mix;
  dry.connect(out);
  dry.connect(delay);
  delay.connect(fb).connect(delay);
  delay.connect(wet).connect(out);
  return dry;
}

const build =
  (s: Sound, root: number): Voice =>
  (c, out, at) => {
    const into = s.mix > 0 ? echoInto(c, out, s) : out;
    s.notes.forEach((n, i) => {
      const last = i === s.notes.length - 1;
      const f = hz(root + n);
      // Web Audio's exponential ramps refuse a zero length.
      swell(c, into, at + i * s.gap, {
        from: f * 2 ** (s.scoop / 12),
        to: f,
        swell: Math.max(s.attack, 0.003),
        glideAt: 0,
        glide: Math.max(s.scoopTime, 0.005),
        fade: Math.max(last ? s.lastFade : s.fade, 0.01),
        voices: voicesOf(s, last && s.chord),
      });
    });
  };

const SEND = file(sendUrl);
const ms = (v: number) => `${Math.round(v * 1000)}ms`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  onCommit: () => void;
}) {
  return (
    <label className="grid grid-cols-[6.5rem_1fr_3.5rem] items-center gap-3">
      <span className="text-muted-foreground">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onPointerUp={props.onCommit}
        onKeyUp={props.onCommit}
      />
      <span className="text-right tabular-nums">{props.format ? props.format(props.value) : props.value}</span>
    </label>
  );
}

function Panel(props: { title: string; root: number; sound: Sound; onChange: (s: Sound) => void; onPlay: () => void }) {
  const { sound: s, onPlay } = props;
  const set = <K extends keyof Sound>(k: K, v: Sound[K]) => props.onChange({ ...s, [k]: v });
  const count = (n: number) => {
    const notes = s.notes.slice(0, n);
    while (notes.length < n) notes.push((notes.at(-1) ?? 0) + 5);
    set("notes", notes);
    onPlay();
  };
  const slider = (label: string, k: keyof Sound, min: number, max: number, step: number, format?: (v: number) => string) => (
    <Slider label={label} value={s[k] as number} min={min} max={max} step={step} format={format} onChange={(v) => set(k, v)} onCommit={onPlay} />
  );

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{props.title}</h2>
        <Button size="sm" variant="outline" onClick={onPlay}>
          Play
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <span className="w-[6.5rem] text-muted-foreground">Notes</span>
        {[1, 2, 3, 4].map((n) => (
          <Button key={n} size="sm" variant={s.notes.length === n ? "default" : "outline"} onClick={() => count(n)}>
            {n}
          </Button>
        ))}
      </div>
      {s.notes.map((n, i) => (
        <Slider
          key={i}
          label={`Note ${i + 1}`}
          value={n}
          min={-12}
          max={24}
          step={1}
          format={(v) => noteName(props.root + v)}
          onChange={(v) => set("notes", s.notes.map((x, j) => (j === i ? v : x)))}
          onCommit={onPlay}
        />
      ))}
      {s.notes.length > 1 && slider("Gap", "gap", 0.02, 0.2, 0.005, ms)}

      <h3 className="mt-2 text-muted-foreground">Shape</h3>
      {slider("Fade in", "attack", 0, 0.15, 0.005, ms)}
      {s.notes.length > 1 && slider("Fade out", "fade", 0.02, 0.4, 0.01, ms)}
      {slider(s.notes.length > 1 ? "Last fade out" : "Fade out", "lastFade", 0.02, 0.6, 0.01, ms)}
      {slider("Slide from", "scoop", -12, 12, 1, (v) => `${v > 0 ? "+" : ""}${v} st`)}
      {s.scoop !== 0 && slider("Slide time", "scoopTime", 0.005, 0.15, 0.005, ms)}
      <label className="flex items-center gap-3">
        <span className="w-[6.5rem] text-muted-foreground">Last as chord</span>
        <input
          type="checkbox"
          checked={s.chord}
          onChange={(e) => {
            set("chord", e.target.checked);
            onPlay();
          }}
        />
      </label>

      <h3 className="mt-2 text-muted-foreground">Tone</h3>
      {slider("Shimmer", "detune", 0, 20, 1, (v) => (v ? `${v}¢` : "off"))}
      {slider("Octave up", "octave", 0, 0.3, 0.01, pct)}
      {slider("Octave down", "sub", 0, 0.4, 0.01, pct)}

      <h3 className="mt-2 text-muted-foreground">Echo</h3>
      {slider("Amount", "mix", 0, 0.8, 0.01, pct)}
      {s.mix > 0 && slider("Time", "echoTime", 0.04, 0.3, 0.005, ms)}
      {s.mix > 0 && slider("Repeats", "feedback", 0, 0.7, 0.01, pct)}
    </section>
  );
}

function Demo() {
  const [config, setConfig] = useState(load);
  const [copied, setCopied] = useState(false);
  // A commit handler can fire before the render carrying the last change, so playback reads this.
  const latest = useRef(config);
  latest.current = config;

  useEffect(() => localStorage.setItem(STORE, JSON.stringify(config)), [config]);

  const playOne = (which: "start" | "stop", delay = 0) =>
    requestAnimationFrame(() => {
      const c = latest.current;
      play(build(c[which], c.root), c.volume, delay);
    });
  const inUse = () => {
    playOne("start");
    playOne("stop", 1.2);
    play(SEND, latest.current.volume, 1.9);
  };
  const copy = () => {
    void navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-8 text-ui">
      <DemoThemeBar />
      <div>
        <h1 className="text-lg font-semibold">Dictation sound</h1>
        <p className="text-muted-foreground">
          Start says the mic is open; stop says the words landed. Releasing a slider plays what it changed.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-muted-foreground">Presets</span>
        {PRESETS.map((p) => (
          <Button key={p.name} size="sm" variant="outline" onClick={() => setConfig(p.config)}>
            {p.name}
          </Button>
        ))}
        <span className="mr-1 ml-4 text-muted-foreground">Compare</span>
        <Button size="sm" variant="outline" onClick={() => play(file(startUrl), config.volume)}>
          Current start
        </Button>
        <Button size="sm" variant="outline" onClick={() => play(file(stopUrl), config.volume)}>
          Current stop
        </Button>
        <Button size="sm" variant="outline" onClick={() => play(SEND, config.volume)}>
          Send
        </Button>
      </div>

      <div className="flex max-w-xl flex-col gap-3">
        <Slider
          label="Root"
          value={config.root}
          min={48}
          max={84}
          step={1}
          format={noteName}
          onChange={(root) => setConfig({ ...config, root })}
          onCommit={() => playOne("start")}
        />
        <Slider
          label="Volume"
          value={config.volume}
          min={0}
          max={1}
          step={0.05}
          format={pct}
          onChange={(volume) => setConfig({ ...config, volume })}
          onCommit={() => playOne("start")}
        />
      </div>

      <div className="flex gap-2">
        <Button size="sm" onClick={inUse}>
          In use
        </Button>
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? "Copied" : "Copy config"}
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Start" root={config.root} sound={config.start} onChange={(start) => setConfig({ ...config, start })} onPlay={() => playOne("start")} />
        <Panel title="Stop" root={config.root} sound={config.stop} onChange={(stop) => setConfig({ ...config, stop })} onPlay={() => playOne("stop")} />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TooltipProvider>
      <Demo />
    </TooltipProvider>
  </React.StrictMode>,
);
