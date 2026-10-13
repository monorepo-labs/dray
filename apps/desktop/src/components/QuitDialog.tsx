import { useEffect, useRef, useState } from "react";

import { invoke, listen } from "@/lib/transport";

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

/// Confirms every quit.
///
/// The backend refuses both routes out — the window's close button and its own
/// ⌘Q menu item — and asks here instead, so this dialog is the only thing that
/// can end the process. Cancelling is therefore not "carry on quitting later":
/// the quit has already been dropped by the time this is on screen.
///
/// It asks regardless of what is running. A quit is cheap to confirm and
/// expensive to get wrong, and a dialog that appears only sometimes is one
/// nobody builds a habit around. Sessions live in the background server, so
/// Quit leaves them running and Quit completely stops that server too.
export default function QuitDialog() {
  const [open, setOpen] = useState(false);
  const quitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const unlisten = listen("quit_requested", () => setOpen(true));
    return () => void unlisten.then((f) => f());
  }, []);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Tells the backend the question was answered. Left unsent, the next
        // ⌘Q would be read as the second half of an unanswered pair and exit
        // without asking.
        if (!next) void invoke("dismiss_quit");
      }}
    >
      <AlertDialogContent
        // Focus on Quit rather than Radix's Cancel: the dialog confirms every
        // quit, so ⌘Q then ⏎ has to be the whole of the common case.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          quitRef.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Quit Dray?</AlertDialogTitle>
          <AlertDialogDescription>
            Sessions keep running in the background. Quit completely stops them too.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* Stopping every session is the rare choice, so it is a quiet ghost
            across the footer from Cancel and Quit rather than beside them. */}
        <AlertDialogFooter className="sm:justify-between">
          <AlertDialogAction
            variant="ghost"
            className="px-px text-muted-foreground hover:bg-transparent hover:text-destructive dark:hover:bg-transparent"
            onClick={() => void invoke("confirm_quit", { stopSessions: true })}
          >
            Quit completely
          </AlertDialogAction>
          <div className="flex gap-2">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction ref={quitRef} onClick={() => void invoke("confirm_quit", { stopSessions: false })}>
              Quit
            </AlertDialogAction>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
