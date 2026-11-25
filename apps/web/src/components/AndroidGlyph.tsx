/// Android's head, square-cut for the downloads page: a stepped dome with
/// the eyes cut out and an antenna either side.
export function AndroidGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" className={className}>
      <path d="M8 6.5h8l3 3V12l2 6.5H3L5 12V9.5zM7.6 12.6h1.8v1.8H7.6zM14.6 12.6h1.8v1.8h-1.8z" />
      <path d="M5.2 3.2l1.2-.7 2.2 3.8-1.2.7zM18.8 3.2l-1.2-.7-2.2 3.8 1.2.7z" />
    </svg>
  );
}
