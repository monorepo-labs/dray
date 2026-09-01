import { useEffect, useState } from "react";

import ChatInput from "@/components/ChatInput";
import DictateControl from "@/components/composer/DictateControl";
import { TooltipProvider } from "@/components/ui/tooltip";
import { appendToDraft } from "@/hooks/useDraft";
import type { RecorderState } from "@/hooks/useTranscription";
import { playDictationSound } from "@/lib/dictationSound";

/// A recorder with no microphone behind it.
///
/// The real one needs permission this cannot get in a browser, and the questions
/// this page answers are what the controls *look* like in each state and what
/// the failure-and-retry sequence feels like end to end — so the level is
/// synthesized and the states are driven by hand. Nothing here is imported by
/// the app; the components below are the real ones.
function useFakeRecorder(): {
  state: RecorderState;
  setState: (next: RecorderState) => void;
  level: number;
} {
  const [state, setState] = useState<RecorderState>("idle");
  const [level, setLevel] = useState(0);

  // Speech-shaped rather than a sine: bursts with gaps, so the bars behave the
  // way they will on a real voice instead of pulsing evenly.
  useEffect(() => {
    if (state !== "recording") {
      setLevel(0);
      return;
    }

    const timer = setInterval(() => {
      setLevel(Math.random() < 0.2 ? Math.random() * 0.15 : 0.25 + Math.random() * 0.75);
    }, 60);

    return () => clearInterval(timer);
  }, [state]);

  return { state, setState, level };
}

function Swatch({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-ui text-muted-foreground">{label}</span>
      <div className="flex h-9 items-center rounded-lg border border-border px-2">
        {children}
      </div>
    </div>
  );
}

/// The composer, its three dictation states, and nothing else.
///
/// Reachable at `/demo.html` under `pnpm dev`. It exists because dictation is
/// gated behind a microphone permission that cannot be granted to a dev binary,
/// which left no way to look at the controls at all.
/// Where a kept recording would sit. Never opened — this page has no backend —
/// but written out in full, since half of what the failure has to say is that
/// the words are somewhere the reader can go and get them.
const DEMO_WAV = "~/.dray/recordings/019bd4c1-7f3a-7e11-9c02-4a1f8e2d6b40.wav";

/// What the model would have answered.
const DEMO_TEXT = "the audio survives a failed transcription now";

/// How long the model takes on a short phrase, near enough.
const RUN_MS = 1400;

export default function ComposerDemo() {
  const recorder = useFakeRecorder();
  const [sent, setSent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  /// Whether the next run answers or falls over. A demo that failed at random
  /// would be one nobody could look at twice, so the failure is a switch.
  const [failNext, setFailNext] = useState(true);
  const [savedAudio, setSavedAudio] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /// One path for stop and retry both, which is the thing worth demonstrating:
  /// in the real hook they share `transcribe_audio` and `apply`, so a retry
  /// cannot answer differently from the stop that preceded it.
  const runModel = () => {
    setError(null);
    recorder.setState("transcribing");

    setTimeout(() => {
      recorder.setState("idle");

      if (failNext) {
        // The file outlives the run, which is the whole change: the words are
        // still on disk and the controls that reach them appear beside the mic.
        setSavedAudio(DEMO_WAV);
        setError("Transcription failed: could not load the model");
        return;
      }

      // The tone lands at the *end* of the wait, where `useRecorder` plays it —
      // on words arriving rather than on the microphone closing.
      playDictationSound("stop");
      setSavedAudio(null);
      appendToDraft("demo-session", DEMO_TEXT);
    }, RUN_MS);
  };

  const dictation = (
    <DictateControl
      state={recorder.state}
      level={recorder.level}
      onStart={() => {
        playDictationSound("start");
        setError(null);
        // Talking again answers the offer to retry the last one. In the real
        // hook this sits *below* the refusals, so a press that never opened the
        // microphone leaves the kept recording on offer; here it always opens.
        setSavedAudio(null);
        recorder.setState("recording");
      }}
      onStop={runModel}
      // Silent, like the real one.
      onCancel={() => recorder.setState("idle")}
      savedAudio={savedAudio}
      onRetry={runModel}
      // The real one hands the path to Finder. There is no Finder here, so it
      // says what it would have done rather than doing nothing.
      onReveal={() => setError(`Finder would open ${savedAudio}`)}
    />
  );

  return (
    <TooltipProvider>
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-10 p-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">Composer</h1>
          <p className="text-ui text-muted-foreground">
            The real components with a faked recorder. No microphone, no backend.
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-ui font-medium text-muted-foreground">
            Dictation, every state
          </h2>
          <div className="grid grid-cols-4 gap-4">
            <Swatch label="Idle">
              <DictateControl
                state="idle"
                level={0}
                savedAudio={null}
                onStart={() => {}}
                onStop={() => {}}
                onCancel={() => {}}
                onRetry={() => {}}
                onReveal={() => {}}
              />
            </Swatch>
            <Swatch label="Recording">
              <DictateControl
                state="recording"
                level={recorder.state === "recording" ? recorder.level : 0.6}
                savedAudio={null}
                onStart={() => {}}
                onStop={() => {}}
                onCancel={() => {}}
                onRetry={() => {}}
                onReveal={() => {}}
              />
            </Swatch>
            <Swatch label="Failed, audio kept">
              <DictateControl
                state="idle"
                level={0}
                savedAudio="/tmp/demo.wav"
                onStart={() => {}}
                onStop={() => {}}
                onCancel={() => {}}
                onRetry={() => {}}
                onReveal={() => {}}
              />
            </Swatch>
            <Swatch label="Transcribing">
              <DictateControl
                state="transcribing"
                level={0}
                savedAudio={null}
                onStart={() => {}}
                onStop={() => {}}
                onCancel={() => {}}
                onRetry={() => {}}
                onReveal={() => {}}
              />
            </Swatch>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-ui font-medium text-muted-foreground">
              In a session — press the mic
            </h2>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-ui text-muted-foreground">
                <input
                  type="checkbox"
                  checked={failNext}
                  onChange={(e) => setFailNext(e.currentTarget.checked)}
                />
                fail the next run
              </label>
              <label className="flex items-center gap-2 text-ui text-muted-foreground">
                <input
                  type="checkbox"
                  checked={busy}
                  onChange={(e) => setBusy(e.currentTarget.checked)}
                />
                busy (Send becomes Stop)
              </label>
            </div>
          </div>

          <p className="text-ui text-muted-foreground">
            Press the mic, then the tick. With <em>fail the next run</em> on, the model
            falls over and the recording is kept: Retry and Show appear beside the mic
            and the words are still on disk. Turn it off and press Retry — the same
            audio goes back through the same path and lands in the draft.
          </p>

          {/* No `toolbar`: it wants models, projects and branches from the
              backend, and the row this page is about is the one holding
              dictation and Send. */}
          <ChatInput
            sessionId="demo-session"
            busy={busy}
            onSend={(text) => setSent((prev) => [...prev, text])}
            onStop={() => setBusy(false)}
            dictation={dictation}
            dictating={recorder.state !== "idle"}
            error={error}
            onDismissError={() => setError(null)}
          />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-ui font-medium text-muted-foreground">
            New task — the centred composer
          </h2>
          <ChatInput
            sessionId={null}
            isNewTask
            onSend={(text) => setSent((prev) => [...prev, text])}
            dictation={dictation}
          />
        </section>

        {sent.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-ui font-medium text-muted-foreground">Sent</h2>
            {sent.map((text, i) => (
              <pre
                key={i}
                className="whitespace-pre-wrap rounded-lg border border-border p-3 text-ui"
              >
                {text}
              </pre>
            ))}
          </section>
        )}
      </div>
    </TooltipProvider>
  );
}
