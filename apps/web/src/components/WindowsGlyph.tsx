/// Windows' four panes, square-cut like the downloads page's other marks.
export function WindowsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M2 2h9.4v9.4H2zM12.6 2H22v9.4h-9.4zM2 12.6h9.4V22H2zM12.6 12.6H22V22h-9.4z" />
    </svg>
  );
}
