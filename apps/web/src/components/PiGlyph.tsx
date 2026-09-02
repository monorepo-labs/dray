/// pi's mark, from its press kit, drawn as its badge: a filled plate with the
/// mark knocked out of it. The primary logo is flat geometry with a hole in the
/// P, and beside Claude's and OpenAI's marks — both of which read as solid
/// objects at 0.72em — it came out as a scattering of loose blocks. The plate
/// gives it the weight those two have.
///
/// So the plate takes `currentColor` and the mark takes the page background,
/// which is what makes the knockout an actual hole rather than a second colour
/// to keep in step with the theme.
///
/// Kept at its native 800 viewBox — the coordinates are exact multiples of the
/// grid the mark is drawn on, and the mark's own 165–635 span inside that box
/// is the plate's padding.
///
/// `fillRule="evenodd"` is load-bearing: the P's counter is a hole cut by a
/// second contour in the same path, and the default `nonzero` fills it in,
/// which reads as a slightly wrong blob rather than as a bug.
///
/// MIT, © Earendil Inc. & Contributors. Credited in the root README.
export function PiGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 800 800"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <rect width="800" height="800" rx="180" fill="currentColor" />
      <path
        fillRule="evenodd"
        className="fill-background"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path
        className="fill-background"
        d="M517.36 400H634.72V634.72H517.36Z"
      />
    </svg>
  );
}
