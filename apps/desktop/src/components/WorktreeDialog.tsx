import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { worktreeCost } from "@/lib/worktree";
import type { WorktreeDisposition } from "@/types/events";

export type WorktreePrompt = {
  sessionId: string;
  worktreeName: string;
  disposition: WorktreeDisposition;
};

/// Confirms a deletion the reader asked for.
///
/// Only the settled bar's own button opens this. Settling raises a notice
/// instead, and the split is the difference between the two moments: there the
/// reader was settling a task and is being *offered* something, so the safe
/// answer has to be the one that costs no clicks; here they pressed "Delete
/// worktree" and are owed a confirm naming what it takes. Both read their copy
/// from [worktree.ts](../lib/worktree.ts), so the two routes cannot come to
/// describe the same deletion differently.
///
/// It lives in `App` rather than beside the button. The composer it sits in
/// unmounts when the session changes — and the sidebar row that used to raise
/// this is gone from the list a frame later, since settling moves it to the
/// other view — so a dialog mounted there would unmount itself mid-question.
///
/// **One step, not two.** The counts *are* the warning, and the app's other
/// destructive controls — the sidebar's delete, the PR panel's merge — use a
/// second confirm precisely because they carry no such detail. Adding one here
/// would make the reader confirm a sentence they had already read.
export default function WorktreeDialog({
  prompt,
  onConfirm,
  onClose,
}: {
  prompt: WorktreePrompt | null;
  onConfirm: (sessionId: string) => Promise<boolean>;
  onClose: () => void;
}) {
  // Held for the fade: Radix keeps `Content` mounted while it closes, and the
  // prompt is already null by then — without this the text swaps to the empty
  // state for the frame the eye is still on.
  const cost = prompt && worktreeCost(prompt.disposition);

  // The dialog stays up while git works. Unlocking the tree, removing it and
  // deleting its branch is three commands over a directory that can be large,
  // and a dialog sitting unchanged through them reads as one the click missed.
  //
  // Reset on *open* rather than on close, for the reason `cost` is held:
  // clearing it as the dialog leaves flips the button back to "Delete anyway"
  // for the length of the fade.
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (prompt) setDeleting(false);
  }, [prompt]);

  // No "Deleted" state to match the notice card's. That card has to keep
  // saying so because the reader is looking elsewhere by then; this dialog is
  // the thing they are looking at, and it closing says it. A failure closes it
  // too — the error banner already carries the reason.
  const confirm = async (sessionId: string) => {
    setDeleting(true);
    await onConfirm(sessionId);
    onClose();
  };

  return (
    <AlertDialog open={prompt !== null} onOpenChange={(next) => !next && !deleting && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this worktree?</AlertDialogTitle>
          <AlertDialogDescription>
            {cost ? (
              <>
                <span className="text-destructive">{cost}</span> will be deleted with{" "}
                <span className="font-medium text-foreground">{prompt?.worktreeName}</span> and its
                branch. The task and everything it said stay.
              </>
            ) : (
              <>
                Deletes{" "}
                <span className="font-medium text-foreground">{prompt?.worktreeName}</span> and its
                branch. Nothing unsaved is in it. The task and everything it said stay.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Keep it</AlertDialogCancel>
          {/* Red whether or not anything is lost: this deletes a directory
              either way, and a button that only turns red sometimes teaches
              the reader to read the colour instead of the sentence. What the
              cost changes is the label. */}
          <AlertDialogAction
            destructive
            // Full strength while disabled: the spinner and the verb are the
            // state, and dimming them as well makes the one live thing on the
            // dialog the hardest part of it to read.
            className="disabled:opacity-100"
            disabled={deleting}
            // Radix's `Action` closes the dialog itself, through
            // `composeEventHandlers` — so `preventDefault` is what holds it up
            // for the work. Without it the deleting state lasts one frame.
            onClick={(e) => {
              e.preventDefault();
              if (prompt) void confirm(prompt.sessionId);
            }}
          >
            {deleting && <Loader2 className="animate-spin" />}
            {deleting ? "Deleting…" : cost ? "Delete anyway" : "Delete worktree"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
