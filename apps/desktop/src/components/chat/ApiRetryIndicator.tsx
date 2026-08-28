import Orb from "@/components/Orb";

/// Shown while the harness retries a failed model request, from `api_retry`
/// until the next request starts or the turn ends. It earns a live indicator
/// for the reason the compaction one does: the turn is open and drawing
/// nothing, so without this the wait is indistinguishable from a slow model —
/// and it is not a short wait, since attempts run to 10 and real sessions reach
/// 7 and beyond.
///
/// The attempt count is the message. A cause is named on well under half of
/// these lines, so it is drawn as a trailing clause when present and the row
/// has to read correctly without it.
export default function ApiRetryIndicator({
  attempt,
  maxRetries,
  status,
  reason,
}: {
  attempt: number;
  maxRetries: number;
  status?: number | null;
  reason?: string | null;
}) {
  // `529 overloaded` where both are known, either alone otherwise. The harness
  // sends `unknown` as its own way of saying nothing, and the mapper drops that
  // on the way in, so anything arriving here is worth showing.
  const cause = [status, reason].filter(Boolean).join(" ");

  return (
    <div className="flex items-center gap-2" aria-live="polite">
      {/* Same 20px inline design as the working and compacting indicators.
          `searching` so a retry reads as a fourth distinct activity rather than
          as ordinary progress. */}
      <Orb state="searching" size={20} aria-hidden />

      <span className="shimmer-text text-chat">
        Retrying — attempt {attempt} of {maxRetries}
        {cause ? ` (${cause})` : ""}
      </span>
    </div>
  );
}
