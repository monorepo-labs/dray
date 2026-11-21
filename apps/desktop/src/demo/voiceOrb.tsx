import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import DictateControl, { DictateOrb } from "@/components/composer/DictateControl";
import VoiceOrb from "@/components/composer/VoiceOrb";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import type { RecorderState } from "@/hooks/useTranscription";
import "../App.css";

/// The composer's voice orb (#1391) in each dictation state, with a fake voice:
/// a level that rises and falls like speech, or the slider's. Dictation can't
/// run in a browser, so the orb's press walks idle → recording → transcribing
/// → idle on a timer instead.
function useFakeVoice(manual: number | null) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (manual !== null) return setLevel(manual);
    const id = setInterval(() => {
      const t = performance.now() / 1000;
      // Syllables over phrases, with pauses: a raw peak, so tiny numbers are normal speech.
      const phrase = Math.max(0, Math.sin(t * 0.9));
      setLevel(phrase * (0.02 + 0.08 * Math.abs(Math.sin(t * 7.3))));
    }, 50);
    return () => clearInterval(id);
  }, [manual]);
  return level;
}

function Demo() {
  const [state, setState] = useState<RecorderState>("idle");
  const [manual, setManual] = useState<number | null>(null);
  const level = useFakeVoice(manual);
  const stop = () => {
    setState("transcribing");
    setTimeout(() => setState("idle"), 1500);
  };
  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col gap-8 bg-background p-10 text-foreground">
        <DemoThemeBar />
        <section className="flex flex-col gap-2">
          <h2 className="text-ui text-muted-foreground">The composer row — press the orb</h2>
          <div className="flex w-[640px] items-end gap-1 rounded-lg border bg-background px-3 py-3">
            <DictateOrb state={state} level={level} onStart={() => setState("recording")} onStop={stop} />
            <div className="flex-1 py-1 text-prompt text-muted-foreground">Ask anything…</div>
            <DictateControl
              state={state}
              savedAudio={null}
              onStop={stop}
              onCancel={() => setState("idle")}
              onRetry={() => {}}
              onReveal={() => {}}
            />
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="text-ui text-muted-foreground">Each state, at the composer's 24px and the phone's 76px</h2>
          <div className="flex items-center gap-6">
            {(["idle", "recording", "transcribing"] as const).map((s) => (
              <div key={s} className="flex flex-col items-center gap-2 text-ui text-muted-foreground">
                <div className="flex items-center gap-4">
                  <VoiceOrb size={24} level={level} state={s} />
                  <VoiceOrb size={76} level={level} state={s} />
                </div>
                {s}
              </div>
            ))}
          </div>
        </section>
        <label className="flex items-center gap-3 text-ui text-muted-foreground">
          <input type="checkbox" checked={manual !== null} onChange={(e) => setManual(e.target.checked ? 0.05 : null)} />
          Level by hand
          <input
            type="range"
            min={0}
            max={0.3}
            step={0.001}
            disabled={manual === null}
            value={manual ?? 0}
            onChange={(e) => setManual(Number(e.target.value))}
          />
        </label>
      </div>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
