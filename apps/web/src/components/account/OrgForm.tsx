"use client";

import { useState } from "react";

import { slugify, slugProblem } from "@/lib/slug";

import { ERROR, INPUT, LABEL, MUTED, PRIMARY } from "./styles";

/// Name and URL slug, shared by New org and Settings. On a new org the slug
/// follows the name until the reader edits it themselves.
export function OrgForm({
  initial,
  submitLabel,
  onSubmit,
  disabled = false,
}: {
  initial?: { name: string; slug: string };
  submitLabel: string;
  onSubmit: (org: { name: string; slug: string }) => Promise<string | null>;
  disabled?: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(!!initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const unchanged = !!initial && name.trim() === initial.name && slug === initial.slug;
  const problem = !name.trim() ? "An org needs a name." : slugProblem(slug);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) return setError(problem);
    setBusy(true);
    setError(await onSubmit({ name: name.trim(), slug }));
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <label className="flex flex-col gap-2">
        <span className={LABEL}>Name</span>
        <input
          value={name}
          disabled={disabled}
          maxLength={80}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
          className={INPUT}
        />
      </label>
      <label className="flex flex-col gap-2">
        <span className={LABEL}>URL</span>
        <div className="flex items-stretch">
          <span className={`flex items-center border border-r-0 border-white/20 px-3 text-[14px] light:border-black/15 ${MUTED}`}>
            drayhq.com/app/
          </span>
          <input
            value={slug}
            disabled={disabled}
            maxLength={40}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
            className={INPUT}
          />
        </div>
      </label>
      {error && <p className={ERROR}>{error}</p>}
      {!disabled && (
        <div>
          <button type="submit" disabled={busy || unchanged} className={PRIMARY}>
            {submitLabel}
          </button>
        </div>
      )}
    </form>
  );
}
