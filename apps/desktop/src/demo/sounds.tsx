import React from "react";
import ReactDOM from "react-dom/client";

import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import { playCelebration, playDictationSound, playNotification } from "@/lib/sound";
import { playSwipeTick } from "@/lib/tick";
import "../App.css";
import sendUrl from "../../../island/Island/send.wav?url";

/// Every sound Dray and Dray Island make, and where each one plays.
///
/// Played through the app's own functions, so volume and clip are what the
/// reader hears. The macOS sounds play from local copies in
/// `demo/system-sounds/`, which is gitignored: Apple's sounds are read off the
/// system by the app and never shipped. Remake them with
/// `afconvert -f WAVE -d LEI16 <system file> demo/system-sounds/<name>.wav`;
/// a row whose copy is missing plays nothing.

/// A local copy of a macOS sound; see above.
const system = (name: string) => () => void new Audio(`/demo/system-sounds/${name}.wav`).play().catch(() => {});

type Sound = {
  name: string;
  file: string;
  play?: () => void;
  where: string[];
};

const APP: Sound[] = [
  {
    name: "Notification",
    file: "public/notification.wav",
    play: playNotification,
    where: [
      "A session finished, asked for permission or asked a question, while the window is focused and the session is not on screen. Beside the in-app notice.",
      "A permission or question card raised in the crew column: the sound alone, no card.",
      "A pull request turned ready to merge. Beside its notice.",
      "⌘S saved the composer's text as a draft.",
    ],
  },
  {
    name: "Celebration",
    file: "public/celebration.wav",
    play: playCelebration,
    where: ["A session settled, from its row or its menu."],
  },
  {
    name: "Dictation start",
    file: "src/assets/dictate-start.wav",
    play: () => playDictationSound("start"),
    where: [
      "The microphone opened for dictation, at 35% volume. Cancel makes no sound.",
      "Heard with Mute while recording on too: the mute waits until the tone has played.",
    ],
  },
  {
    name: "Dictation stop",
    file: "src/assets/dictate-stop.wav",
    play: () => playDictationSound("stop"),
    where: ["The dictated words landed in the composer, not when the microphone closed. Text outcomes only."],
  },
  {
    name: "Swipe tick",
    file: "src/lib/tick.ts (made in code)",
    play: playSwipeTick,
    where: [
      "Each project a sidebar swipe steps past.",
      "The project filter chords, which step through the same list.",
    ],
  },
];

const ISLAND: Sound[] = [
  {
    name: "Notification",
    file: "public/notification.wav, bundled",
    play: playNotification,
    where: [
      "A permission or question card arrived while the panel is shut. Not while Dray is the app in front.",
      "A session finished where Dray would have posted its banner: the done pill.",
      "News held while the reader was busy in the panel, once the pill can be seen.",
    ],
  },
  {
    name: "Dictation start",
    file: "src/assets/dictate-start.wav, bundled",
    play: () => playDictationSound("start"),
    where: [
      "The microphone opened, from the orb or a tap of the island's key. Full volume there.",
      "Heard with Mute while recording on, as in Dray.",
    ],
  },
  {
    name: "Dictation stop",
    file: "src/assets/dictate-stop.wav, bundled",
    play: () => playDictationSound("stop"),
    where: ["Dictated words became a row in the draft."],
  },
  {
    name: "Send",
    file: "apps/island/Island/send.wav",
    play: () => void new Audio(sendUrl).play().catch(() => {}),
    where: [
      "A message sent from the island, as the panel says Sent. Not on card answers or drafts.",
      "Shimmer lift, picked on the send-sound page and rendered at 25%.",
    ],
  },
  {
    name: "Screen Capture",
    file: "macOS: SystemSounds/system/Screen Capture.aif",
    play: system("screen-capture"),
    where: ["A screenshot taken into the draft, from the camera or ⌘⇧2."],
  },
];

const BANNER: Sound[] = [
  {
    name: "System default",
    file: "macOS: the reader's alert sound",
    where: ["The desktop banner for a finished session, while the reader is in another app."],
  },
  {
    name: "Ping",
    file: "macOS: /System/Library/Sounds/Ping.aiff",
    play: system("ping"),
    where: ["The desktop banner for a permission or question, so it stands out from the default."],
  },
];

function Section({ title, note, sounds }: { title: string; note: string; sounds: Sound[] }) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="text-muted-foreground">{note}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {sounds.map((s) => (
          <li key={s.name + s.file} className="flex items-start gap-3 rounded-lg border border-border p-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{s.name}</div>
              <div className="font-mono text-xs text-muted-foreground">{s.file}</div>
              <ul className="mt-1.5 list-disc pl-4 text-muted-foreground">
                {s.where.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
            {s.play && (
              <Button size="sm" variant="outline" onClick={s.play}>
                Play
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Demo() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-8 text-ui">
      <DemoThemeBar />
      <div>
        <h1 className="text-lg font-semibold">Sounds</h1>
        <p className="text-muted-foreground">Every sound Dray and Dray Island make, and where each one plays.</p>
      </div>
      <Section title="Dray" note="Played in the window." sounds={APP} />
      <Section title="Dray Island" note="Dray's files, bundled into the island, and one of macOS's own." sounds={ISLAND} />
      <Section
        title="Desktop banners"
        note="macOS plays these with the banner. The default is whatever alert sound the reader picked."
        sounds={BANNER}
      />
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
