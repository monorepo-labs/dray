import { useId } from "react";

/// A rounded rectangle with its left column filled — the sidebar toggle, drawn
/// after VS Code's. Heroicons has no panel glyph and `ViewColumnsIcon`, its
/// nearest, reads as a table. Stroke width and 24px box match the heroicons
/// outline set so it sits beside them without looking heavier.
export default function PanelLeftIcon({
  dim = false,
  ...props
}: React.ComponentProps<"svg"> & {
  /// Fades the filled column — the sidebar it stands for isn't showing.
  dim?: boolean;
}) {
  // Per-instance so two icons on one page can't share a clip path id.
  const clipId = useId();

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden="true"
      {...props}
    >
      {/* The fill is a plain rect clipped to the rounded outline, so its top-left
          and bottom-left follow the border's arc instead of squaring off. */}
      <clipPath id={clipId}>
        <rect x="3" y="5" width="18" height="14" rx="2.5" />
      </clipPath>
      <rect
        x="3"
        y="5"
        width="6.5"
        height="14"
        fill="currentColor"
        fillOpacity={dim ? 0.3 : 1}
        stroke="none"
        clipPath={`url(#${clipId})`}
      />
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      {/* No divider stroke between the column and the rest: the filled block is
          already the edge, and at `dim` the fill drops to 30% while a stroke
          would stay at full weight — leaving a hard line marking a pane that
          isn't there. */}
    </svg>
  );
}
