import { useId } from "react";

/// A solid globe: a filled disc with its parallels and one meridian cut out.
/// Heroicons' solid globes are a line drawing or continents, and neither reads
/// beside the other solid marks in the titlebar.
export default function GlobeFilledIcon({ className }: { className?: string }) {
  const cut = useId();
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className}>
      <mask id={cut}>
        <rect width="16" height="16" fill="white" />
        <g fill="none" stroke="black" strokeWidth="1.2">
          <path d="M1 5.6h14M1 10.4h14" />
          <ellipse cx="8" cy="8" rx="3" ry="7" />
        </g>
      </mask>
      <circle cx="8" cy="8" r="7" fill="currentColor" mask={`url(#${cut})`} />
    </svg>
  );
}
