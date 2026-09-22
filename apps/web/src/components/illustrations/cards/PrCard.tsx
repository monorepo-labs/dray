import {
  CheckPassed,
  CheckRow,
  CheckRunning,
  CommentRow,
  PrRow,
  Readiness,
  Section,
  VercelMark,
} from "@/components/app/Panel";
import { GreptileGlyph } from "@/components/GreptileGlyph";
import s from "./Cards.module.css";

/// The PR tab's rows, without the panel frame — the card is the frame. The
/// review check passes, readiness follows, then the reviewer's threads land.
///
/// The two states of each label sit side by side and the hidden one is cut
/// to zero width, not stacked in a grid cell: a cell is as wide as the wider
/// text, which left "Ready to merge" with the width of "Checks not passing"
/// and a gap before "into main".
export function PrCard() {
  return (
    <div className={`flex flex-col gap-4 pb-3 ${s.scene}`}>
      <PrRow number={44} title="Stop background tasks holding the turn open" added={275} removed={70} />
      <Readiness
        tone="ready"
        ready
        base="main"
        label={
          <>
            <span className={`text-accent-command ${s.running}`}>Checks not passing</span>
            <span className={s.passed}>Ready to merge</span>
          </>
        }
        detail={
          <span className="grid">
            <span className={`col-start-1 row-start-1 ${s.whileRunning}`}>
              Merging is allowed, but something is red.
            </span>
            <span className={`col-start-1 row-start-1 ${s.whilePassed}`}>
              Every check passed and the review is in.
            </span>
          </span>
        }
      />
      <Section
        title="Checks"
        count={
          <>
            <span className={s.running}>1 running · 1 passed</span>
            <span className={s.passed}>2 passed</span>
          </>
        }
      >
        <CheckRow
          name="Greptile Review"
          avatar={<GreptileGlyph className="size-2.5" />}
          state={
            <span className="grid size-3.5 shrink-0">
              <CheckRunning className={`col-start-1 row-start-1 ${s.whileRunning}`} />
              <CheckPassed className={`col-start-1 row-start-1 ${s.whilePassed}`} />
            </span>
          }
        />
        <CheckRow name="Vercel" avatar={<VercelMark />} state={<CheckPassed />} />
      </Section>
      <Section title="Comments" count={2}>
        <div className="flex flex-col gap-2">
          <CommentRow
            avatar={<GreptileGlyph className="size-2.5" />}
            author="greptile-apps"
            preview="Greptile Summary"
            age="4m"
          />
          <div className={s.reviewed}>
            <CommentRow
              avatar={<GreptileGlyph className="size-2.5" />}
              author="greptile-apps"
              word="reviewed"
              replies={2}
              age="1m"
            />
          </div>
        </div>
      </Section>
    </div>
  );
}
