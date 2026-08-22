import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
/// nobody builds a habit around.
export default function QuitDialog() {
  const [open, setOpen] = useState(false);

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
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Quit Dray?</AlertDialogTitle>
          <AlertDialogDescription>
            Running tasks will stop. They pick up where they left off next time.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => void invoke("confirm_quit")}>
            Quit
          </AlertDialogAction>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
