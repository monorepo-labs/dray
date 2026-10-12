import { useId } from "react";

/// A rounded rectangle with its left column filled — the sidebar toggle, drawn
/// after VS Code's. Heroicons has no panel glyph and `ViewColumnsIcon`, its
/// nearest, reads as a table. Stroke width and 24px box match the heroicons
/// outline set so it sits beside them without looking heavier.
export default function PanelLeftIcon({ className, ...props }: React.ComponentProps<"svg">) {
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
      className={className}
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
        stroke="none"
        clipPath={`url(#${clipId})`}
      />
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      {/* No divider stroke between the column and the rest: the filled block is
          already the edge, and a stroke there would draw a hard line down the
          middle of a glyph that is meant to read as one shape. */}
    </svg>
  );
}
