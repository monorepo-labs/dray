import { cn } from "@/lib/utils";

/// A rotating arc, drawn rather than borrowed.
///
/// Lucide's `Loader2` is what this replaces, and the reason is geometry: its
/// glyph is not centred in its own box, so rotating it traces a small orbit and
/// reads as a wobble at 14–16px. This is one circle concentric with the
/// viewBox, so the spin has nothing to be off-centre about.
///
/// `pathLength` normalizes the circle to 100 units whatever the radius, which
/// is what lets the arc be written as a share of the ring rather than
/// recomputed from `2πr` every time the size changes. Short and quick on
/// purpose — a sixth of the ring at 0.4s reads as a flick of light travelling,
/// where the usual quarter-ring at 1s reads as a wait.
export default function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      // On the `svg`, not the `circle`: an SVG child's `transform-origin`
      // resolves against the viewport's origin rather than its own box, so a
      // spin applied there swings the arc around the top-left corner.
      // `animate-spin` for the keyframes and a duration override beside it,
      // rather than an arbitrary `animate-[spin_…]`: Tailwind v4 only emits a
      // `@keyframes` block for a name some `--animate-*` theme variable
      // reaches, so spelling the animation out by hand is how you get a rule
      // that references keyframes the build then leaves out.
      //
      // `will-change-transform` is what stops the wobble, and it is about where
      // the spinner sits rather than about this shape: unpromoted, Chromium
      // re-rasterizes the rotating box every frame and snaps it to whole device
      // pixels, so a 16px arc orbits by a subpixel. It only shows over the
      // window's vibrancy — the PR panel's merge button wobbled where the
      // composer's dictation spinner, on an opaque fill, did not.
      className={cn(
        "size-4 animate-spin will-change-transform [animation-duration:0.4s]",
        className,
      )}
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.2" />
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray="15 85"
      />
    </svg>
  );
}
