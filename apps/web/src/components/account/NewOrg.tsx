"use client";

import { useRouter } from "next/navigation";

import { authClient } from "@/lib/auth-client";

import { OrgForm } from "./OrgForm";

/// The New org form, landing on the org's servers once it exists.
export function NewOrg() {
  const router = useRouter();
  return (
    <OrgForm
      submitLabel="Create org"
      onSubmit={async (org) => {
        const { error } = await authClient.organization.create(org);
        if (error) return error.message ?? "Couldn't create the org.";
        router.push(`/app/${org.slug}/servers`);
        return null;
      }}
    />
  );
}
