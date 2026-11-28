import { Badge } from "./Badge";
import { Button } from "./Button";

export type PricingCardProps = {
  plan?: string;
  price?: string;
  blurb?: string;
  features?: string[];
  popular?: boolean;
};

export function PricingCard({
  plan = "Pro",
  price = "$24",
  blurb = "For small teams shipping every week.",
  features = ["Unlimited projects", "Preview deploys", "Email support"],
  popular = false,
}: PricingCardProps) {
  return (
    <div className="flex w-80 flex-col gap-5 rounded-card border border-line bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{plan}</h3>
        {popular && <Badge>Most popular</Badge>}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-4xl font-bold tracking-tight">{price}</span>
        <span className="text-sm text-ink-muted">/ month</span>
      </div>
      <p className="text-sm leading-6 text-ink-muted">{blurb}</p>
      <ul className="flex flex-col gap-2 text-sm">
        {features.map((f) => (
          <li key={f} className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-brand-500" />
            {f}
          </li>
        ))}
      </ul>
      <Button variant={popular ? "primary" : "secondary"}>Choose {plan}</Button>
    </div>
  );
}
