import { ThinkingOrb } from "thinking-orbs";

/// Shown while the CLI rewrites the conversation into a summary, between
/// `context_compaction_started` and `context_compacted`. It earns a live
/// indicator rather than a settled row because it takes real time — seconds on
/// a small context, over two minutes on a full one — with nothing else on
/// screen to explain the wait.
export default function CompactingIndicator() {
  return (
    <div className="flex items-center gap-2" aria-live="polite">
      {/* Same 20px inline design as WorkingIndicator, `shaping` so it reads as
          a third distinct activity next to `working` and `weaving`. Theme
          pinned for the same reason as there: the orb's `auto` expects
          `data-theme="dark|light"` and this app stamps a palette name. */}
      <ThinkingOrb state="shaping" size={20} theme="dark" aria-hidden />

      <span className="shimmer-text text-chat">Compacting context</span>
    </div>
  );
}
