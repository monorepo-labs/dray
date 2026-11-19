/// A square-cut Tux drawn for the downloads page in Paper: belly, eyes and beak
/// cut out so whatever is behind shows through. The homepage keeps Simple
/// Icons' Tux (`LinuxGlyph`).
export function TuxMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" className={className}>
      <path d="M8.5 1h7l2 4.5v5l4 7-2 2.5h-15l-2-2.5 4-7v-5zM9.5 9.8h5l1.8 7-1.8 3.2h-5l-1.8-3.2zM9.6 3.6h1.6V6H9.6zM12.8 3.6h1.6V6h-1.6zM10.4 7h3.2L12 8.8z" />
      <path d="M3.5 20.6H11L10 23H2.5zM13 20.6h7.5l1 2.4H14z" />
    </svg>
  );
}
