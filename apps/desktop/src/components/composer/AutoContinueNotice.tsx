import Orb from "@/components/Orb";
import { Button } from "@/components/ui/button";
import { resetTime } from "@/lib/format";

/// The `continue` the server will send once the usage limit resets (#477), and
/// the switch for it: Cancel turns it off, and the row stays as the way back on
/// until the time passes.
///
/// Never blocks sending: a prompt typed now goes out (and is refused until the
/// reset), and any send drops the schedule anyway.
///
/// `mb-7` clears the handoff row's hover zone, which reaches 28px above the
/// composer — any closer and hovering the orb opens those buttons over it.
/// `px-3` puts the orb on the composer's text edge and Cancel's box on the
/// send button's.
export default function AutoContinueNotice({
  at,
  off,
  onToggle,
}: {
  at: string;
  off: boolean;
  onToggle: (on: boolean) => void;
}) {
  if (off) {
    return (
      <div className="mb-7 flex items-center px-3">
        {/* Pulled left by the button's own inset, so its label starts where
            the composer's text does. */}
        <Button variant="ghost" size="sm" className="-ml-2.5" onClick={() => onToggle(true)}>
          Continue when limit resets
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-7 flex items-center gap-3 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Orb state="waiting" className="shrink-0" />
        <p className="truncate text-ui text-foreground">
          Continues automatically at {resetTime(at)}
        </p>
      </div>
      <Button variant="ghost" size="sm" className="shrink-0" onClick={() => onToggle(false)}>
        Cancel
      </Button>
    </div>
  );
}
