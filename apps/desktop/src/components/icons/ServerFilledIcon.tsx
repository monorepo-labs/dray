import { useId } from "react";

/// Lucide's `Server` made solid: two filled racks with their lights cut out.
/// Its own `fill-current` would paint over the lights, which are what make it
/// read as a server rather than two bars.
export default function ServerFilledIcon({ className }: { className?: string }) {
  const cut = useId();
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <mask id={cut}>
        <rect width="24" height="24" fill="white" />
        <circle cx="6" cy="6.25" r="1.5" fill="black" />
        <circle cx="6" cy="16.75" r="1.5" fill="black" />
      </mask>
      {/* Spans y 2–21, the band lucide's stroked `Folder` covers, so the two
          read as one height side by side in the composer. */}
      <g fill="currentColor" mask={`url(#${cut})`}>
        <rect x="1" y="2" width="22" height="8.5" rx="2.5" />
        <rect x="1" y="12.5" width="22" height="8.5" rx="2.5" />
      </g>
    </svg>
  );
}
