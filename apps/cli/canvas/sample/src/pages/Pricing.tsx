import { PricingCard } from "../components/PricingCard";

export function Pricing() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col items-center gap-10 px-6 py-16">
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Simple pricing</h1>
        <p className="max-w-md text-ink-muted">Start free. Upgrade when your team grows.</p>
      </header>
      <div className="flex flex-wrap justify-center gap-6">
        <PricingCard plan="Hobby" price="$0" blurb="For side projects." features={["3 projects", "Community support"]} />
        <PricingCard popular />
        <PricingCard plan="Team" price="$79" blurb="For growing teams." features={["Everything in Pro", "SSO", "Priority support"]} />
      </div>
    </main>
  );
}
