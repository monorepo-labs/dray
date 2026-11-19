/// A server: two stacked units, each with a light and a slot cut out. Filled
/// and square-cornered to sit beside the Apple, Tux and Android marks.
export function ServerGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" className={className}>
      <path d="M2 3h20v8H2zM5 6h2v2H5zM10 6.25h9v1.5h-9zM2 13h20v8H2zM5 16h2v2H5zM10 16.25h9v1.5h-9z" />
    </svg>
  );
}
