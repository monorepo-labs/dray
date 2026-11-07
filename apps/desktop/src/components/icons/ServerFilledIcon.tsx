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
        <circle cx="6" cy="6" r="1.5" fill="black" />
        <circle cx="6" cy="18" r="1.5" fill="black" />
      </mask>
      <g fill="currentColor" mask={`url(#${cut})`}>
        <rect x="1" y="1" width="22" height="10" rx="3" />
        <rect x="1" y="13" width="22" height="10" rx="3" />
      </g>
    </svg>
  );
}
