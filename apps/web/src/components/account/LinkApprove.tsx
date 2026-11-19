"use client";

import { type FormEvent, useState, useTransition } from "react";

import { approveLink, denyLink } from "@/app/link/actions";

import { BlueCard, Card, Cards, CloseIcon, Heading, Label, OrgIcon, ServerIcon } from "./SignInParts";

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
        <Label>Cancelled</Label>
        <Heading>{name} won&apos;t be linked. You can close this tab.</Heading>
      </>
    );
  if (outcome)
    return (
      <>
        <Label>Linked</Label>
        <Heading>
          {name} joins {outcome.linked.name} in a few seconds. You can close this tab.
        </Heading>
        <Cards>
          <Card icon={<ServerIcon />} label="View servers" corner href={`/app/${outcome.linked.slug}/servers`} />
          <Spacer />
          <Spacer />
        </Cards>
      </>
    );

  const approve = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const answer = await approveLink(code, org.id);
      if ("error" in answer) setError(answer.error);
      else setOutcome({ linked: { ...org, ...answer.org } });
    });
  };
  const cancel = () => {
    setError(null);
    start(async () => {
      const problem = await denyLink(code);
      if (problem) setError(problem);
      else setOutcome("cancelled");
    });
  };

  return (
    <form onSubmit={approve}>
      {error ? <Label danger>{error.replace(/\.\s*$/, "")}</Label> : <Label>Link a server</Label>}
      <Heading>Approve only a code you started yourself.</Heading>
      <Cards>
        <Card icon={<ServerIcon />} label={name} detail={<span className="font-mono tracking-[0.12em]">{code}</span>} />
        <Card
          icon={<OrgIcon />}
          label={
            orgs.length > 1 ? (
              <select
                aria-label="Org"
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                className="-ml-1 w-full max-w-full cursor-pointer truncate bg-transparent pr-2 text-white/80 outline-none [&>option]:bg-[#1C1C1C]"
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                    {o.id === currentOrgId ? " (linked here now)" : ""}
                  </option>
                ))}
              </select>
            ) : (
              org.name
            )
          }
          detail={moves ? "Linked to another org; approving moves it" : "The org it joins"}
        />
        <BlueCard label="Approve" busy={pending} />
        <Card icon={<CloseIcon />} label="Cancel" disabled={pending} onClick={cancel} />
      </Cards>
    </form>
  );
}

/// Keeps a lone card at the width it has in a row of three.
function Spacer() {
  return <div className="hidden min-w-0 flex-1 basis-0 sm:block" />;
}
