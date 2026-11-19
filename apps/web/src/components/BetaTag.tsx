/// The small outlined tag beside a name: "Beta" on the Linux app, "TestFlight"
/// on the iPhone's. Takes the colour of whatever it sits in, so one tag serves
/// a filled button and a grey link.
export function BetaTag({ className = "", label = "Beta" }: { className?: string; label?: string }) {
  return (
    <span
      className={`inline-flex h-4 items-center rounded-[4px] border border-current/35 px-1 font-mono text-[10px] leading-none tracking-[0.06em] uppercase ${className}`}
    >
      {label}
    </span>
  );
}
