"use client";

import { useState, useTransition } from "react";

import { allowConnect, cancelConnect } from "@/app/connect/actions";
import { authClient } from "@/lib/auth-client";

import { ERROR, H1, LABEL, LEAD, MUTED, PRIMARY, ROWS, SECONDARY } from "./styles";

/// The Allow step of an assistant's MCP sign-in: which assistant, which
/// server, as whom, where it goes back to, and how much it may do.
export function ConnectApprove({
  id,
  client,
  server,
  org,
  email,
  redirectHost,
}: {
  id: string;
  client: string;
  server: string;
  org: string;
  email: string;
  redirectHost: string;
}) {
  const [readOnly, setReadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [pending, start] = useTransition();

  const go = (action: () => Promise<{ url: string } | { error: string }>) =>
    start(async () => {
      const answer = await action();
      if ("error" in answer) return setError(answer.error);
      setLeaving(true);
      window.location.assign(answer.url);
    });

  const row = "flex items-center gap-4 px-4 py-3";
  const choices = [
    { readOnly: false, title: "Full access", detail: "List, start, message and stop sessions, and answer their cards." },
    { readOnly: true, title: "Read only", detail: "List and read sessions. Nothing it does changes anything." },
  ];
  return (
    <>
      <h1 className={H1}>Connect {client} to {server}.</h1>
      <p className={LEAD}>Allow only a connection you started yourself.</p>

      <dl className={`mt-10 ${ROWS}`}>
        <div className={row}>
          <dt className={`w-24 shrink-0 ${LABEL}`}>Server</dt>
          <dd className="min-w-0 truncate text-[15px]">
            {server} <span className={MUTED}>in {org}</span>
          </dd>
        </div>
        <div className={row}>
          <dt className={`w-24 shrink-0 ${LABEL}`}>Account</dt>
          <dd className="min-w-0 truncate text-[15px]">{email}</dd>
        </div>
        <div className={row}>
          <dt className={`w-24 shrink-0 ${LABEL}`}>Returns to</dt>
          <dd className="min-w-0 truncate text-[15px]">{redirectHost}</dd>
        </div>
      </dl>

      <fieldset className="mt-8">
        <legend className={`mb-3 ${LABEL}`}>Access</legend>
        <div className={ROWS}>
          {choices.map((c) => (
            <label
              key={c.title}
              className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-white/5 light:hover:bg-black/[0.03]"
            >
              <input
                type="radio"
                name="access"
                checked={readOnly === c.readOnly}
                onChange={() => setReadOnly(c.readOnly)}
                className="mt-[5px] accent-white light:accent-[#0A0A0A]"
              />
              <span className="min-w-0">
                <span className="block text-[15px]">{c.title}</span>
                <span className={`block text-[13px] ${MUTED}`}>{c.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-8 flex gap-2">
        <button
          type="button"
          disabled={pending || leaving}
          className={PRIMARY}
          onClick={() => go(() => allowConnect(id, readOnly))}
        >
          Allow
        </button>
        <button
          type="button"
          disabled={pending || leaving}
          className={SECONDARY}
          onClick={() => go(() => cancelConnect(id))}
        >
          Cancel
        </button>
      </div>
      {error && <p className={`mt-3 ${ERROR}`}>{error}</p>}
    </>
  );
}

/// Signs out and comes back to this sign-in, for a reader who signed in with
/// the wrong Google account.
export function OtherAccount({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className={SECONDARY}
      onClick={async () => {
        setBusy(true);
        await authClient.signOut();
        window.location.assign(`/login?next=${encodeURIComponent(`/connect/${id}`)}`);
      }}
    >
      Use another account
    </button>
  );
}
