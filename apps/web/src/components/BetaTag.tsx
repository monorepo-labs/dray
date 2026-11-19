/// The small outlined "Beta" beside the Linux app's name. Takes the colour of
/// whatever it sits in, so one tag serves a filled button and a grey link.
export function BetaTag({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex h-4 items-center rounded-[4px] border border-current/35 px-1 font-mono text-[10px] leading-none tracking-[0.06em] uppercase ${className}`}
    >
      Beta
    </span>
  );
}
