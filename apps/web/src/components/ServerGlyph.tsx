/// A server: two stacked units, each with three vents and a light cut out.
/// Filled and square-cornered, drawn for the downloads page in Paper.
export function ServerGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" className={className}>
      <path d="M2 3h20v8H2zM16.5 6H19v2h-2.5zM5 5.5h1.2v3H5zM7.5 5.5h1.2v3H7.5zM10 5.5h1.2v3H10zM2 13h20v8H2zM16.5 16H19v2h-2.5zM5 15.5h1.2v3H5zM7.5 15.5h1.2v3H7.5zM10 15.5h1.2v3H10z" />
    </svg>
  );
}
