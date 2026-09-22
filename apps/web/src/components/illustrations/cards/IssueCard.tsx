import { Composer } from "@/components/app/Chat";
import { IssueChip, IssuePicker, IssueRow } from "@/components/app/Issue";
import s from "./Cards.module.css";

/// The composer with `#` typed: the picker opens under it on the reader's
/// own issues, ↓ moves the highlight, ⏎ lands one in the sentence as a chip
/// carrying its title. The input alone — the row of controls under it is
/// chrome around the thing this card is about — and the picker hangs off
/// it into the card's own space, so nothing is reserved for it while it is
/// closed.
export function IssueCard() {
  return (
    <div className={`relative px-2 pb-2 ${s.scene}`}>
      <Composer
        model="Opus 5"
        mode="Auto"
        toolbar={false}
        radius="rounded-lg"
        value={
          <>
            Fix the flicker in{" "}
            {/* `#` and the chip that replaces it share one cell, so the line
                never shifts when the pick lands. */}
            <span className="inline-grid items-baseline align-baseline">
              <span className={`col-start-1 row-start-1 ${s.hash}`}>#</span>
              <IssueChip className={`col-start-1 row-start-1 ${s.chip}`}>
                #Window transparency percentage
              </IssueChip>
            </span>
            <span className={s.tail}> on open</span>
          </>
        }
      />
      {/* The highlight is cut from one row to the next rather than slid:
          that is what an arrow key does. */}
      <IssuePicker className={s.picker}>
        <IssueRow kind="started" id="DRA-184" title="Browser tab auto-opens side pane" priority={2} highlight={s.row1} />
        <IssueRow kind="unstarted" id="DRA-159" title="Window transparency percentage" priority={1} highlight={s.row2} />
        <IssueRow kind="unstarted" id="DRA-172" title="Dev build shares the release profile" priority={3} />
      </IssuePicker>
    </div>
  );
}
