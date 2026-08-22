/// Git branch glyph. Heroicons has no equivalent, and the outline set's stroke
/// weight is what the rest of the chrome matches, so this is drawn to that spec
/// rather than pulled from another icon family.
export default function GitBranchIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="6" cy="5" r="2.25" />
      <circle cx="6" cy="19" r="2.25" />
      <circle cx="18" cy="7" r="2.25" />
      <path d="M6 7.25v9.5" />
      <path d="M18 9.25a6 6 0 0 1-6 6H6" />
    </svg>
  );
}
