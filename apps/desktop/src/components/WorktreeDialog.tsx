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
///
/// **And it does not wait for git.** Unlocking the tree, removing it and
/// deleting its branch is three commands over a directory that can be large,
/// and this used to stay up through all three behind a spinner — which said
/// "still going" for a second and a half and nothing else. The press starts the
/// work and the dialog leaves on it, so there is no `deleting` state here at
/// all: nothing on this surface outlives the click.
///
/// Closing is the whole of the confirmation, and it can be, because the reader
/// is looking straight at it. What that costs is the one answer that arrives
/// too late to draw here — a removal git refuses. The notice stack takes it as
/// a `worktree-failed` card, because by then the reader has been told it worked
/// and has to be told otherwise.
export default function WorktreeDialog({
  prompt,
  onConfirm,
  onClose,
}: {
  prompt: WorktreePrompt | null;
  /// Starts the removal. It answers nothing, by design — see above.
  onConfirm: (sessionId: string) => void;
  onClose: () => void;
}) {
  // Held for the fade: Radix keeps `Content` mounted while it closes, and the
  // prompt is already null by then — without this the text swaps to the empty
  // state for the frame the eye is still on.
  const cost = prompt && worktreeCost(prompt.disposition);

  return (
    <AlertDialog open={prompt !== null} onOpenChange={(next) => !next && onClose()}>
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
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          {/* Red whether or not anything is lost: this deletes a directory
              either way, and a button that only turns red sometimes teaches
              the reader to read the colour instead of the sentence. What the
              cost changes is the label. */}
          <AlertDialogAction
            destructive
            // No `preventDefault`. Radix's `Action` closes the dialog itself
            // through `composeEventHandlers`, which used to be the thing held
            // up for the git work and is now exactly what is wanted.
            onClick={() => prompt && onConfirm(prompt.sessionId)}
          >
            {cost ? "Delete anyway" : "Delete worktree"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
