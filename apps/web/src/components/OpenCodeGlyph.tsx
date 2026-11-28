/// OpenCode's mark, from its brand page (opencode.ai/brand), on `currentColor`.
/// The brand files draw the counter's lower half as the same ink at 28% on
/// dark and 20% on light, so one path with an opacity per scheme covers both.
///
/// Kept at its native 240×300 viewBox; `meet` centres the tall mark in the
/// square box the other glyphs fill.
export function OpenCodeGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 240 300"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <path d="M180 240H60V120H180V240Z" className="opacity-[0.28] light:opacity-20" />
      <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" />
    </svg>
  );
}
