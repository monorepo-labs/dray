import { X } from "lucide-react";

import Orb from "@/components/Orb";
import { Button } from "@/components/ui/button";
import type { PlaceStep } from "@/lib/cloud";

const SAID: Record<PlaceStep, [string, string]> = {
  starting: ["Starting a cloud machine", "This can take a minute. The task goes when it's up."],
  cloning: ["Cloning onto its cloud machine", "The task goes once the clone lands."],
};

/// A new task getting its own cloud machine. Sits where `BoatNotice` does, in
/// the same shape.
export function CloudNotice({ step }: { step: PlaceStep }) {
  const [title, detail] = SAID[step];
  return (
    <div className="mb-2 flex min-h-7 items-center gap-2 px-1">
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        <Orb state="searching" variant="lighthouse" speed={3} label={title} />
      </span>
      <p className="min-w-0 flex-1 truncate text-ui text-foreground">
        {title}
        <span className="text-muted-foreground">
          {" · "}
          {detail}
        </span>
      </p>
    </div>
  );
}

/// A cloud step that failed — no machine started, a clone or a resume that
/// didn't land — said in full, with Retry sending the composer's text again.
export function CloudFailedNotice({
  message,
  onRetry,
  onDismiss,
}: {
  message: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mb-2 flex min-h-7 items-start gap-2 px-1">
      <p className="min-w-0 flex-1 py-1 text-ui break-words text-destructive">{message}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Retry
      </Button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="mt-1.5 shrink-0 rounded p-0.5 text-destructive opacity-70 transition-opacity hover:opacity-100"
      >
        <X className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}
