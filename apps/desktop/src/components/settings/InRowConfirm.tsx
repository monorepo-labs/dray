import type { ReactNode } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/// A settings row's question, asked in place: Cancel, then the verb. Cancel
/// leads so Enter pressed twice out of habit changes nothing.
export function CancelOrConfirm({
  verb,
  onConfirm,
  onCancel,
  destructive = true,
  busy = false,
  autoFocus = false,
  className,
  children,
}: {
  verb: string;
  onConfirm: () => void;
  onCancel: () => void;
  /// Off for a switch that loses nothing, where red would say it does.
  destructive?: boolean;
  busy?: boolean;
  /// Takes the focus the unmounting button just dropped — not stealing, since a
  /// keyboard user was on this very spot.
  autoFocus?: boolean;
  className?: string;
  /// Drawn ahead of the pair, for a row that names its question.
  children?: ReactNode;
}) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {children}
      <Button autoFocus={autoFocus} variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button
        variant={destructive ? "destructive" : "outline"}
        size="sm"
        disabled={busy}
        onClick={onConfirm}
      >
        {verb}
      </Button>
    </div>
  );
}

/// A list row's question, asked in place: Confirm, then an X to keep the row.
/// Two controls where two sat before, so the row answers without a sentence
/// shoving its name sideways.
export function ConfirmOrKeep({
  confirmLabel,
  keepLabel,
  onConfirm,
  onKeep,
  size = "xs",
}: {
  /// Spoken names, since the pair sits on a row among others like it.
  confirmLabel: string;
  keepLabel: string;
  onConfirm: () => void;
  onKeep: () => void;
  size?: "xs" | "sm";
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button size={size} variant="destructive" aria-label={confirmLabel} onClick={onConfirm}>
        Confirm
      </Button>
      <Button
        variant="ghost"
        size={size === "xs" ? "icon-xs" : "icon-sm"}
        aria-label={keepLabel}
        onClick={onKeep}
        className="text-muted-foreground hover:text-foreground"
      >
        <X />
      </Button>
    </div>
  );
}
