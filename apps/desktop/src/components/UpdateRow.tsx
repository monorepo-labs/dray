import { Check, Download, RotateCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type ManualCheck, updateFailure } from "@/hooks/useUpdater";
import type { UpdateStatus } from "@/types/events";

type UpdateRowProps = {
  status: UpdateStatus | null;
  /// A turn is in flight somewhere. Installing swaps the bundle and relaunches,
  /// which kills the child mid-turn, so the button waits rather than warning.
  blocked: boolean;
  /// Where something the user asked for has got to. The check verdicts are only
  /// drawn when there is no `status` — a real update outranks any verdict about
  /// not finding one — while the two install failures are drawn over the ready
  /// button, which is the offer they are a failure of.
  manual: ManualCheck;
  onInstall: () => void;
};

/// The update notice, pinned to the sidebar's bottom edge.
///
/// Drawn only while there is something to say — the sidebar has no permanent
/// footer, and a row that reads "up to date" is chrome for a fact nobody asked
/// about. Nothing shows while the sidebar is collapsed; the next check keeps
/// the offer alive, and an update is not urgent enough to earn a second home in
/// the header.
export default function UpdateRow({
  status,
  blocked,
  manual,
  onInstall,
}: UpdateRowProps) {
  // Nothing found, and a hand-triggered check waiting on or reporting that.
  // Still nothing at all for the scheduled check, which is the common case and
  // asked no question.
  if (!status) {
    if (manual === "idle") return null;
    return (
      <Footer>
        <Note>
          {manual === "checking" && (
            <>
              <RotateCw className="size-4 shrink-0 animate-spin" />
              Checking for updates…
            </>
          )}
          {manual === "up_to_date" && (
            <>
              <Check className="size-4 shrink-0" />
              Up to date
            </>
          )}
          {manual === "failed" && (
            <>
              <TriangleAlert className="size-4 shrink-0" />
              Couldn't check for updates
            </>
          )}
        </Note>
      </Footer>
    );
  }

  if (status.state === "downloading") {
    return (
      <Footer>
        <div className="flex items-center gap-2 px-1.5 py-1 text-ui text-muted-foreground">
          <Download className="size-4 shrink-0" />
          <span className="truncate">Downloading v{status.version}</span>
          {status.percent !== null && (
            <span className="ml-auto tabular-nums">{status.percent}%</span>
          )}
        </div>
      </Footer>
    );
  }

  // `aria-disabled` rather than `disabled`, because the reason lives in a
  // tooltip and a disabled button fires no pointer events to open one — it also
  // leaves the tab order, so a keyboard user would get the dimming and no
  // explanation at all. The click is guarded instead of the button.
  const button = (
    <Button
      variant="ghost"
      size="sm"
      aria-disabled={blocked}
      onClick={() => !blocked && onInstall()}
      className="w-full justify-start px-1.5 text-ui aria-disabled:cursor-default aria-disabled:opacity-50"
    >
      <RotateCw />
      Restart to update
      <span className="ml-auto text-muted-foreground tabular-nums">
        v{status.version}
      </span>
    </Button>
  );

  // Over the button, not instead of it: the downloaded update is still held, so
  // pressing again is the cure for one of the two failures and harmless for the
  // other.
  const failure = updateFailure(manual);

  return (
    <Footer>
      {failure && (
        <Note>
          <TriangleAlert className="size-4 shrink-0" />
          {failure}
        </Note>
      )}
      {blocked ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="top">
            Waiting for the running task to finish.
          </TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
    </Footer>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return <div className="shrink-0 px-2 py-2">{children}</div>;
}

/// A line the row states rather than offers — same metrics as the downloading
/// line, so the footer doesn't change height as a check moves through it.
function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1.5 py-1 text-ui text-muted-foreground">
      {children}
    </div>
  );
}
