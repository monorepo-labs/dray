import { cn } from "@/lib/utils";

/// GitHub's mark.
///
/// [LinearIcon]'s sibling and the same bargain: drawn where the reader is being
/// asked about GitHub *specifically* — the tracker chips, and the line under
/// the connect form naming `gh auth login` — and nowhere else. Everywhere else
/// the surface says "issue".
///
/// Hand-written rather than taken from a library: lucide ships no brand icons,
/// and a dependency for one path is a dependency for one path.
///
/// `currentColor`, not black: this sits beside Linear's mark in a row of muted
/// chrome, and two marks that disagree about whether to be loud read as one of
/// them being wrong.
///
/// [LinearIcon]: ./LinearIcon.tsx
export default function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("size-4 shrink-0", className)}
      fill="currentColor"
      role="img"
      aria-label="GitHub"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
