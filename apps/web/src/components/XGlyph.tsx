/// X's mark, `currentColor` so it sits in the footer's muted chrome like
/// GitHub's does in the nav.
export function XGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M9.52 6.78 15.48 0h-1.41L8.89 5.89 4.76 0H0l6.25 8.9L0 16h1.41l5.46-6.22L11.24 16H16L9.52 6.78Zm-1.93 2.2-.63-.89L1.92 1.04h2.17l4.06 5.72.63.89 5.28 7.42h-2.17L7.59 8.98Z" />
    </svg>
  );
}
