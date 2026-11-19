"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { approveLink, denyLink } from "@/app/link/actions";

import { ERROR, H1, LABEL, LEAD, MUTED, PRIMARY, ROWS, SECONDARY } from "./styles";

type Org = { id: string; name: string; slug: string };

/// The approve step of linking a server: its name and code to check against
/// the terminal, the org it joins (picked only when there is a choice), and
/// Approve or Cancel.
export function LinkApprove({
  code,
  name,
  orgs,
  initialOrgId,
  linkedElsewhere,
  currentOrgId,
}: {
  code: string;
  name: string;
  orgs: Org[];
  initialOrgId: string;
  /// Whether the server already belongs to an org.
  linkedElsewhere: boolean;
  /// That org, where it is one of the reader's.
  currentOrgId: string | null;
}) {
  const [orgId, setOrgId] = useState(initialOrgId);
  const [outcome, setOutcome] = useState<{ linked: Org } | "cancelled" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const org = orgs.find((o) => o.id === orgId) ?? orgs[0];
  const moves = linkedElsewhere && orgId !== currentOrgId;

  if (outcome === "cancelled")
    return (
      <>
        <h1 className={H1}>Cancelled.</h1>
        <p className={LEAD}>{name} won&apos;t be linked. You can close this tab.</p>
      </>
    );
  if (outcome)
    return (
      <>
        <h1 className={H1}>Linked.</h1>
        <p className={LEAD}>
          {name} joins {outcome.linked.name} in a few seconds. You can close this tab.
        </p>
        <div className="mt-10">
          <Link href={`/app/${outcome.linked.slug}/servers`} className={SECONDARY}>
            View servers
          </Link>
        </div>
      </>
    );

  const row = "flex items-center gap-4 px-4 py-3";
  return (
    <>
      <h1 className={H1}>Link a server.</h1>
      <p className={LEAD}>Approve only a code you started yourself.</p>

      <dl className={`mt-10 ${ROWS}`}>
        <div className={row}>
          <dt className={`w-20 shrink-0 ${LABEL}`}>Server</dt>
          <dd className="min-w-0 truncate text-[15px]">{name}</dd>
        </div>
        <div className={row}>
          <dt className={`w-20 shrink-0 ${LABEL}`}>Code</dt>
          <dd className="font-mono text-[15px] tracking-[0.12em]">{code}</dd>
        </div>
        {orgs.length === 1 && (
          <div className={row}>
            <dt className={`w-20 shrink-0 ${LABEL}`}>Org</dt>
            <dd className="min-w-0 truncate text-[15px]">{org.name}</dd>
          </div>
        )}
      </dl>

      {orgs.length > 1 && (
        <fieldset className="mt-8">
          <legend className={`mb-3 ${LABEL}`}>Org</legend>
          <div className={ROWS}>
            {orgs.map((o) => (
              <label key={o.id} className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-white/5 light:hover:bg-black/[0.03]">
                <input
                  type="radio"
                  name="org"
                  value={o.id}
                  checked={o.id === orgId}
                  onChange={() => setOrgId(o.id)}
                  className="accent-white light:accent-[#0A0A0A]"
                />
                <span className="min-w-0 truncate text-[15px]">{o.name}</span>
                {o.id === currentOrgId && <span className={`ml-auto shrink-0 text-[13px] ${MUTED}`}>Linked here now</span>}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {moves && (
        <p className="mt-6 border-l-2 border-[#FFE14D] pl-3 text-[14px]">
          It&apos;s linked to another org; approving moves it.
        </p>
      )}

      <div className="mt-8 flex gap-2">
        <button
          type="button"
          disabled={pending}
          className={PRIMARY}
          onClick={() =>
            start(async () => {
              const answer = await approveLink(code, org.id);
              if ("error" in answer) setError(answer.error);
              else setOutcome({ linked: { ...org, ...answer.org } });
            })
          }
        >
          Approve
        </button>
        <button
          type="button"
          disabled={pending}
          className={SECONDARY}
          onClick={() =>
            start(async () => {
              const problem = await denyLink(code);
              if (problem) setError(problem);
              else setOutcome("cancelled");
            })
          }
        >
          Cancel
        </button>
      </div>
      {error && <p className={`mt-3 ${ERROR}`}>{error}</p>}
    </>
  );
}
