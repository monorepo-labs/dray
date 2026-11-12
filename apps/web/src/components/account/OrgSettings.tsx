"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

import { OrgForm } from "./OrgForm";
import { BOX, DANGER, ERROR, INPUT, MUTED } from "./styles";

type Org = { id: string; name: string; slug: string };

/// The org's settings: name and URL for owners and admins, Leave for anyone
/// but an owner, Delete for the owner alone and never on their only org.
/// Better Auth enforces each of these again; the page only hides what would
/// be refused.
export function OrgSettings({
  org,
  isOwner,
  canManage,
  onlyOrg,
}: {
  org: Org;
  isOwner: boolean;
  canManage: boolean;
  onlyOrg: boolean;
}) {
  const router = useRouter();

  const save = async (data: { name: string; slug: string }) => {
    const { error } = await authClient.organization.update({ organizationId: org.id, data });
    if (error) return error.message ?? "Couldn't save.";
    if (data.slug !== org.slug) router.replace(`/app/${data.slug}/settings`);
    router.refresh();
    return null;
  };

  return (
    <div className="mt-8 flex flex-col gap-12">
      <section>
        <OrgForm initial={org} submitLabel="Save" onSubmit={save} disabled={!canManage} />
        {!canManage && <p className={`mt-3 text-[13px] ${MUTED}`}>Only owners and admins can change these.</p>}
      </section>
      {!isOwner && <LeaveOrg org={org} />}
      {isOwner && !onlyOrg && <DeleteOrg org={org} />}
    </div>
  );
}

function LeaveOrg({ org }: { org: Org }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const leave = async () => {
    const { error } = await authClient.organization.leave({ organizationId: org.id });
    if (error) return setError(error.message ?? "Couldn't leave.");
    router.push("/app");
    router.refresh();
  };

  return (
    <section className={`${BOX} flex flex-col gap-3 p-4`}>
      <h2 className="text-[15px]">Leave {org.name}</h2>
      <p className={`text-[13px] ${MUTED}`}>You lose access to its servers.</p>
      {error && <p className={ERROR}>{error}</p>}
      <div>
        <button type="button" onClick={leave} className={DANGER}>
          Leave org
        </button>
      </div>
    </section>
  );
}

function DeleteOrg({ org }: { org: Org }) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    const { error } = await authClient.organization.delete({ organizationId: org.id });
    if (error) {
      setError(error.message ?? "Couldn't delete.");
      return setBusy(false);
    }
    router.push("/app");
    router.refresh();
  };

  return (
    <section className={`border border-[#FF5A4E]/40 flex flex-col gap-3 p-4`}>
      <h2 className="text-[15px]">Delete {org.name}</h2>
      <p className={`text-[13px] ${MUTED}`}>
        Unlinks every server in it and removes its members. Type <strong>{org.name}</strong> to confirm.
      </p>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        aria-label="Org name to confirm"
        className={INPUT}
      />
      {error && <p className={ERROR}>{error}</p>}
      <div>
        <button type="button" onClick={remove} disabled={busy || typed !== org.name} className={DANGER}>
          Delete org
        </button>
      </div>
    </section>
  );
}
