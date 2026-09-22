import { Composer } from "@/components/app/Chat";
import { MicButton, RecordingControls } from "@/components/app/Dictate";
import s from "./Cards.module.css";

/// The input alone, with the mic pressed: the bars hear the reader, the
/// stop is pressed, and the words land.
export function DictateCard() {
  return (
    <div className={`px-2 pb-2 ${s.scene}`}>
      <Composer
        model="Opus 5"
        mode="Auto"
        toolbar={false}
        radius="rounded-lg"
        value={<span className={s.words}>Persist the sidebar width, and collapse it on ⌘B.</span>}
        controls={
          // The three states share one cell: the mic, the recording row and
          // the spinner that stands in for the tick while the model listens.
          <span className="grid justify-items-end">
            <MicButton className={`col-start-1 row-start-1 ${s.mic}`} />
            <RecordingControls
              className={`col-start-1 row-start-1 ${s.rec}`}
              barClass={(i) => (i % 2 ? s.barB : s.barA)}
            />
            <span
              className={`col-start-1 row-start-1 grid size-7 place-items-center rounded-full bg-primary text-primary-foreground ${s.spin}`}
            >
              <Spinner />
            </span>
          </span>
        }
      />
    </div>
  );
}

/// One ring concentric with its box, spun on the `svg` — the app's own
/// spinner, drawn because lucide's is not centred in its box at 14px.
function Spinner() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 animate-spin" aria-hidden>
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray="70 30"
      />
    </svg>
  );
}
