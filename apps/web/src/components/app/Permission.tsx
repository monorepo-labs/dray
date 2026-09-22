import type { ReactNode } from "react";

import { cx } from "@/components/app/Window";

/// The app's permission card, as `PermissionRequest` draws it: the argument
/// outlined in mono, one sentence, and the CLI's options in a row — the
/// one-shot answer filled, the standing rule outlined, the refusal in the
/// destructive wash. Buttons are spans: nothing here is pressed by the reader,
/// so an animation is what presses one.
export function PermissionCard({
  argument,
  description,
  options,
  className,
}: {
  argument?: string;
  description: string;
  options: { label: string; kind: "once" | "always" | "deny"; className?: string }[];
  className?: string;
}) {
  return (
    <div className={cx("rounded-2xl border border-border bg-card p-4", className)}>
      {argument && (
        <pre className="mb-3 overflow-x-auto rounded-lg border border-border px-3 py-2.5 font-mono text-xs">
          {argument}
        </pre>
      )}
      <p className="text-chat leading-snug">{description}</p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {options.map((o) => (
          <Option key={o.label} kind={o.kind} className={o.className}>
            {o.label}
          </Option>
        ))}
      </div>
    </div>
  );
}

const KIND = {
  once: "bg-primary text-primary-foreground",
  always: "border-border bg-background",
  deny: "bg-destructive/20 text-destructive",
};

function Option({
  kind,
  className,
  children,
}: {
  kind: keyof typeof KIND;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-7 items-center rounded-[min(var(--radius-md),12px)] border border-transparent px-2.5 text-[0.8rem] font-medium whitespace-nowrap",
        KIND[kind],
        className,
      )}
    >
      {children}
    </span>
  );
}
