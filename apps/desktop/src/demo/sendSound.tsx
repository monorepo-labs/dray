import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import "../App.css";
import { file, play, SHIMMER, swell, type Voice } from "@/demo/swell";

/// Which sound the island makes on a send.
///
/// Messages' own cannot ship. Its shape, measured off the system's copy: a
/// near-pure sine that swells in for ~200ms at ~350Hz, lifts about four
/// semitones right at its loudest, and fades over ~160ms. Plucks read as
/// notifications, whooshes as something else, and a plain lift at other notes
/// still as Messages — so the ones made here keep the swell and the lift and
/// change one more thing each: the timbre, the contour or the ending.
///
/// Shimmer lift was picked, and `apps/island/Island/send.wav` is it rendered at
/// 25%. Retuning it means rendering the file again from
/// these same numbers; the page and the file are two statements of one sound.
///
/// The open-source sounds play from `demo/oss-sounds/`, and Messages from
/// `demo/system-sounds/`, both gitignored. Remake them from their sources —
/// AOSP Messaging's `res/raw/message_sent.wav`, KDE Ocean's
/// `ocean/stereo/service-login.oga` (which its `message-sent-instant` links
/// to), Pidgin's `share/sounds/send.wav` — converted with ffmpeg to wav.
/// Number keys play each one; judge in Safari, the app's engine.

type Sound = { id: string; name: string; like: string; voice: Voice };

const GROUPS: { title: string; note: string; sounds: Sound[] }[] = [
  {
    title: "Reference",
    note: "Apple's. It cannot ship, and neither can a copy of its shape.",
    sounds: [{ id: "messages", name: "Messages", like: "macOS's Sent Message", voice: file("/demo/system-sounds/sent-message.wav") }],
  },
  {
    title: "Open source",
    note: "Shippable under their licences, with credit where the licence asks.",
    sounds: [
      {
        id: "android",
        name: "Android Messaging",
        like: "AOSP's message_sent — Apache 2.0, credit in the notices",
        voice: file("/demo/oss-sounds/android-message-sent.wav"),
      },
      {
        id: "kde",
        name: "KDE Ocean",
        like: "Plasma's message-sent-instant — CC BY-SA 4.0, Guilherme Marçal Silva",
        voice: file("/demo/oss-sounds/kde-message-sent.wav"),
      },
      {
        id: "pidgin",
        name: "Pidgin",
        like: "Pidgin's send — GPLv2, which binds the app shipping it",
        voice: file("/demo/oss-sounds/pidgin-send.wav"),
      },
    ],
  },
  {
    title: "Made here",
    note: "Messages' swell and lift, each changed in a second way too: the sound, the shape, or how it ends.",
    sounds: [
      {
        id: "harmony",
        name: "Harmony lift",
        like: "two tones a third apart swelling and lifting together, where Messages is one",
        voice: (c, out, at) => swell(c, out, at, { from: 330, to: 440, swell: 0.15, glideAt: 0.12, glide: 0.06, fade: 0.15, voices: [[1, 0.5, 0], [1.26, 0.3, 0]] }),
      },
      {
        id: "shimmer",
        name: "Shimmer lift",
        like: "a pair of slightly detuned tones, so it shimmers, lifting a fourth",
        voice: (c, out, at) => swell(c, out, at, { from: 370, to: 494, swell: 0.16, glideAt: 0.13, glide: 0.06, fade: 0.16, voices: SHIMMER }),
      },
      {
        id: "bell",
        name: "Bell lift",
        like: "glassier, with bell overtones and a longer ring after the lift",
        voice: (c, out, at) => swell(c, out, at, { from: 392, to: 523, swell: 0.14, glideAt: 0.11, glide: 0.05, fade: 0.22, voices: [[1, 0.5, 0], [2.76, 0.07, 0], [5.4, 0.025, 0]] }),
      },
      {
        id: "settle",
        name: "Lift and settle",
        like: "lifts a fifth, overshoots a touch and settles back as it fades",
        voice: (c, out, at) => swell(c, out, at, { from: 350, to: 540, settle: 525, swell: 0.15, glideAt: 0.12, glide: 0.05, fade: 0.17, voices: [[1, 0.55, 0], [2, 0.04, 0]] }),
      },
      {
        id: "whoop",
        name: "Whoop",
        like: "the rise spread through the whole swell rather than kept for the peak",
        voice: (c, out, at) => swell(c, out, at, { from: 300, to: 470, swell: 0.18, glideAt: 0, glide: 0.18, fade: 0.15, voices: [[1, 0.55, 0], [2, 0.05, 0]] }),
      },
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.sounds);

function Demo() {
  const [volume, setVolume] = useState(0.6);
  const [last, setLast] = useState<string | null>(null);
  const pick = (sound: Sound) => {
    setLast(sound.id);
    play(sound.voice, volume);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sound = ALL[Number(e.key) - 1];
      if (sound) pick(sound);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-8 text-ui">
      <DemoThemeBar />
      <div>
        <h1 className="text-lg font-semibold">Send sound</h1>
        <p className="text-muted-foreground">Candidates for the island's send. Press a number key, or Play.</p>
      </div>

      <label className="flex items-center gap-3">
        Volume
        <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
        <span className="tabular-nums text-muted-foreground">{Math.round(volume * 100)}%</span>
      </label>

      {GROUPS.map((group) => (
        <section key={group.title} className="flex flex-col gap-2">
          <div>
            <h2 className="font-semibold">{group.title}</h2>
            <p className="text-muted-foreground">{group.note}</p>
          </div>
          <ul className="flex flex-col gap-2">
            {group.sounds.map((sound) => (
              <li
                key={sound.id}
                className={`flex items-center gap-3 rounded-lg border p-3 ${last === sound.id ? "border-foreground/40" : "border-border"}`}
              >
                <span className="w-4 tabular-nums text-muted-foreground">{ALL.indexOf(sound) + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{sound.name}</div>
                  <div className="text-muted-foreground">{sound.like}</div>
                </div>
                <Button size="sm" variant="outline" onClick={() => pick(sound)}>
                  Play
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ))}
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
