import { BorderBeam } from "border-beam";

import { useTheme } from "@/hooks/useTheme";
import { useDriven } from "@/lib/browser";

/// The glow along a tab's edge while the agent drives it, beside the orb its
/// favicon turns into. Laid over the tab rather than wrapped round it: the
/// package's wrapper clips its overflow and spends both pseudo-elements,
/// which would take the panel tab's flared foot with it. Mounted for the
/// tab's whole life, so `active` can fade it out.
///
/// The style is inline because the package injects its own `position:
/// relative` on the same element, after Tailwind's sheet. The tab must be
/// positioned for the overlay to sit on it.
///
/// The preset's glow is 60px tall and a tab 28px, so unmasked it lights the
/// overlay's whole rounded outline; the mask keeps it to the one edge.
/// `top` flips it onto the top edge for the panel strip, whose foot runs into
/// the URL row — `line` has no top preset, and a vertical flip keeps the beam
/// travelling the same way. The mask is written pre-flip, so `to top`.
export default function AgentBeam({ tab, top = false }: { tab: number; top?: boolean }) {
  const driven = useDriven(tab) !== null;
  const { resolvedMode } = useTheme();
  return (
    <BorderBeam
      size="line"
      theme={resolvedMode}
      active={driven}
      borderRadius={8}
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        // Second layer: off the rounded corners, so the line stays straight.
        maskImage:
          "linear-gradient(to top, #000 30%, transparent 70%), linear-gradient(to right, transparent 8px, #000 14px, #000 calc(100% - 14px), transparent calc(100% - 8px))",
        maskComposite: "intersect",
        WebkitMaskComposite: "source-in",
        transform: top ? "scaleY(-1)" : undefined,
        // Back and forth rather than left to right and restart. Reaches every
        // animation in the preset's list; the one-shot fades are unmoved,
        // since `alternate` only turns even iterations round.
        animationDirection: "alternate",
      }}
    >
      <span />
    </BorderBeam>
  );
}
