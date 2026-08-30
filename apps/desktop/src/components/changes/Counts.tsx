/// Git's own numstat figures for one file or one range, in the one pair of
/// colours the app uses for added and removed.
///
/// Shared rather than copied: the turn panel, the repo view's lists and the
/// diff pane's header all draw this, and three versions would eventually
/// disagree about which minus sign or which green.
export default function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono text-ui">
      {added > 0 && <span className="text-accent-add">+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {/* U+2212, not a hyphen: it matches the plus's weight and width. */}
      {removed > 0 && <span className="text-destructive">−{removed}</span>}
    </span>
  );
}
