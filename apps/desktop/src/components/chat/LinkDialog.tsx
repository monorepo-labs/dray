import { Copy, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { LinkSafetyModalProps } from "streamdown";

import { Button } from "@/components/ui/button";
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

/// The confirm a transcript link opens, in place of Streamdown's own.
///
/// Its modal is replaced rather than restyled because its Open button calls
/// `window.open`, which a Tauri webview answers by doing nothing at all — no
/// error, no navigation, so the dialog reads as a dead button next to a Copy
/// link that works. The route out of the app is `openUrl`, the same one the PR
/// panel takes, and `onConfirm` is therefore deliberately unused.
export default function LinkDialog({ url, isOpen, onClose }: LinkSafetyModalProps) {
  // Both buttons close, so neither needs a "Copied" state — the dialog going
  // away is the confirmation, and a card that stays up after being answered
  // asks the reader to dismiss it twice.
  const copy = async () => {
    await navigator.clipboard.writeText(url);
    onClose();
  };

  const open = async () => {
    try {
      await openUrl(url);
    } catch (err) {
      console.error("failed to open link", err);
    }
    onClose();
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Open this link?</AlertDialogTitle>
          <AlertDialogDescription>It opens in your default browser.</AlertDialogDescription>
        </AlertDialogHeader>
        {/* The whole URL, wrapping and scrolling rather than truncating — the
            host is the reason to show it and the tail is where a link lies. */}
        <div className="max-h-32 overflow-y-auto rounded-md bg-muted p-3 font-mono text-ui break-all">
          {url}
        </div>
        <AlertDialogFooter>
          <Button
            variant="ghost"
            size="sm"
            className="text-ui sm:mr-auto"
            onClick={() => void copy()}
          >
            <Copy />
            Copy link
          </Button>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            // Radix closes on click; `preventDefault` holds it open until the
            // opener has answered, so a failure closes through `open` alone.
            onClick={(e) => {
              e.preventDefault();
              void open();
            }}
          >
            <ExternalLink />
            Open link
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
