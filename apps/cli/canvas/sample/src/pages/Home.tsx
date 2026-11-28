import { Button } from "../components/Button";

export function Home() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col items-start gap-6 px-6 py-24">
      <span className="text-sm font-medium text-brand-600">Acme</span>
      <h1 className="text-5xl font-bold tracking-tight">Ship your site in an afternoon.</h1>
      <p className="text-lg text-ink-muted">Acme hosts, previews and scales your frontend.</p>
      <div className="flex gap-3">
        <Button>Get started</Button>
        <Button variant="secondary">See pricing</Button>
      </div>
    </main>
  );
}
