import { Copy, ExternalLink, Globe } from "lucide-react";

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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { dismissLink, resolveLink, usePendingLink } from "@/lib/openLink";

/// The question a transcript link asks: here, or in the system browser.
///
/// One dialog for the whole app, fed by `openLink`'s store, since links are
/// rendered by Streamdown and the user bubble several components below
/// anything that could hold the state. Return opens in Dray — the common
/// answer — and the whole URL is shown, wrapping rather than truncating: the
/// host is the reason to show it and the tail is where a link lies.
export default function LinkDialog() {
  const url = usePendingLink();

  const copy = async () => {
    if (url) await navigator.clipboard.writeText(url);
    dismissLink();
  };

  return (
    <AlertDialog open={url !== null} onOpenChange={(next) => !next && dismissLink()}>
      {/* Wider than the default card: three answers and a copy sit on one
          row, and a grid child's `min-width: auto` would otherwise let the
          row set the width and run out past the edge. */}
      <AlertDialogContent
        className="max-w-120"
        // Radix focuses Cancel on open, so Return would dismiss. The answer
        // wanted from a bare Return is the in-app one.
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return;
          e.preventDefault();
          resolveLink(false);
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Open this link?</AlertDialogTitle>
          <AlertDialogDescription>
            In Dray's browser, or in your default browser.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-32 min-w-0 overflow-y-auto rounded-md bg-muted p-3 font-mono text-ui break-all">
          {url}
        </div>
        <AlertDialogFooter className="min-w-0 sm:items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Copy link"
                className="sm:mr-auto"
                onClick={() => void copy()}
              >
                <Copy />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Copy link</TooltipContent>
          </Tooltip>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="outline" onClick={() => resolveLink(true)}>
            <ExternalLink />
            System browser
          </Button>
          <AlertDialogAction onClick={() => resolveLink(false)}>
            <Globe />
            Open in Dray
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
