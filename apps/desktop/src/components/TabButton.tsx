import { cn } from "@/lib/utils";

/// One entry in a row where exactly one is on.
///
/// The main column's views, the right panel's panes and the settings page's
/// groups are the same control wearing three labels, so the look lives here
/// rather than as three copies of one class string — which is the shape that
/// drifts on whichever row nobody is looking at. Extras stay at the call site:
/// the count badge, the keycap tooltip, the roving `tabIndex`.
export default function TabButton({
  active,
  className,
  ...props
}: { active: boolean } & React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        // WebKit's own ring is the system blue: a grey one in its place, for
        // keys alone. Inside the edge, so no scrolling row clips it; 55% holds
        // 3:1 against the page and the selected fill alike.
        "rounded-md px-2 py-1 text-ui transition-colors outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-foreground/55",
        active
          ? "bg-[var(--fill-soft,var(--sidebar-accent))] text-sidebar-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
