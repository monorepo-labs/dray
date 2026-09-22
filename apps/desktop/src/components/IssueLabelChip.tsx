import { useTheme } from "@/hooks/useTheme";
import { readableStateColor } from "@/lib/issueColor";
import { cn } from "@/lib/utils";
import type { IssueLabel } from "@/types/events";

/// One label, in the colour the tracker gave it.
///
/// A label has no meaning apart from that colour, unlike a status, which folds
/// onto a fixed vocabulary — so it is drawn rather than approximated. **Through
/// `readableStateColor`, the same correction the state glyphs take**: a GitHub
/// repository picks its label colours against GitHub's own white background and
/// half of them are pale (`#ffffff` for `wontfix`, `#ededed` for `no-review`),
/// which reads on this app's dark palette and vanishes on its light one. That
/// function keeps the hue and spends the lightness, so a green label stays green
/// and only stops being invisible.
///
/// Its own component because three surfaces draw one — the page's rows, the
/// panel's detail and the filter menu's dot — and a per-site copy would leave
/// them disagreeing about the mode the first time one forgot to read it.
export default function IssueLabelChip({
  label,
  dot,
  className,
}: {
  label: IssueLabel;
  /// Draw the colour alone, for a row that already carries the name as text.
  dot?: boolean;
  className?: string;
}) {
  const { resolvedMode } = useTheme();
  const color = label.color ? readableStateColor(label.color, resolvedMode === "light") : null;

  if (dot) {
    return (
      <span
        className={cn("size-2 shrink-0 rounded-full", className)}
        style={{ background: color ?? "var(--muted-foreground)" }}
      />
    );
  }

  return (
    <span
      className={cn("shrink-0 rounded-full border px-1.5 py-px", className)}
      style={{ borderColor: color ?? undefined, color: color ?? undefined }}
    >
      {label.name}
    </span>
  );
}
