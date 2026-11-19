/// A phone: a square-cornered slab with the speaker and home bar cut out.
/// Drawn for the downloads page in Paper, beside the server and Tux marks.
export function PhoneGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" className={className}>
      <path d="M6 1h12v22H6zM10 2.6h4V4h-4zM10 20.4h4v.9h-4z" />
    </svg>
  );
}
