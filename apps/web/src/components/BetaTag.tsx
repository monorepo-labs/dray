/// The small outlined tag beside a name: "Beta" on the Linux app, "TestFlight"
/// on the iPhone's. Takes the colour of whatever it sits in, so one tag serves
/// a filled button and a grey link. `plain` sets it in the page's own font
/// rather than mono caps.
export function BetaTag({
  className = "",
  plain = false,
  label = "Beta",
}: {
  className?: string;
  plain?: boolean;
  label?: string;
}) {
  const type = plain
    ? "h-[18px] px-1.5 text-[11px] font-medium"
    : "h-4 px-1 font-mono text-[10px] tracking-[0.06em] uppercase";
  return (
    <span className={`inline-flex items-center rounded-[4px] border border-current/35 leading-none ${type} ${className}`}>
      {label}
    </span>
  );
}
