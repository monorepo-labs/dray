/// Greptile's mark, from greptile.com/logo.svg, recoloured to `currentColor`
/// so it sits at the same weight as the name beside it. The source ships one
/// flat fill, so there is nothing to keep in step with the theme.
///
/// Taller than it is wide, unlike every other mark on this page — size it with
/// a height and let the width follow, or it comes out squashed.
export function GreptileGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 367 420"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <path d="M240.269 49.8154L166.804 115.963L115.966 159.44L181.335 220.585L249.784 162.048L196.78 112.47L253.068 61.7881L362.605 164.246L178.739 321.489L3.14502 157.242L187.011 0L240.269 49.8154Z" />
      <rect
        width="236.453"
        height="83.4566"
        transform="matrix(0.75471 -0.656059 0 1 188.017 336.544)"
      />
      <rect
        width="236.453"
        height="83.4566"
        transform="matrix(0.731354 0.681998 0 1 0 174.962)"
      />
    </svg>
  );
}
