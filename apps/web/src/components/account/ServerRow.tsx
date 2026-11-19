"use client";

import { useState, useTransition } from "react";

import { renameServer, setServerAccess, unlinkServer } from "@/app/app/[slug]/servers/actions";

import { DANGER, ERROR, INPUT, LABEL, MUTED, ROWS, SECONDARY } from "./styles";

type Member = { id: string; name: string; email: string; allowed: boolean };

/// One linked server. Owners and admins rename it in place, unlink it, and
/// open its allow list; unlinking asks once more on the same button.
export function ServerRow({
  server,
  canManage,
  members,
}: {
  server: { id: string; name: string; linked: string };
  canManage: boolean;
  /// The org's members, each marked with whether they're on the allow list.
  members: Member[];
}) {
  const [editing, setEditing] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const allowed = members.filter((m) => m.allowed).length;
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (action: () => Promise<string | null>, after?: () => void) =>
    start(async () => {
      const problem = await action();
      setError(problem);
      if (!problem) after?.();
    });

  return (
    <li className="px-4 py-3">
      {editing ? (
        <form
          className="flex gap-2"
          action={(form) => run(() => renameServer(server.id, String(form.get("name"))), () => setEditing(false))}
        >
          <input name="name" defaultValue={server.name} autoFocus maxLength={80} className={INPUT} aria-label="Server name" />
          <button type="submit" disabled={pending} className={SECONDARY}>
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} className={SECONDARY}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-[15px]">{server.name}</p>
            <p className={`text-[13px] ${MUTED}`}>
              {server.linked} · {allowed === 1 ? "1 person" : `${allowed} people`} can connect assistants
            </p>
          </div>
          {canManage && (
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                aria-expanded={showAccess}
                onClick={() => setShowAccess(!showAccess)}
                className={SECONDARY}
              >
                Access
              </button>
              <button type="button" onClick={() => setEditing(true)} className={SECONDARY}>
                Rename
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => (confirming ? run(() => unlinkServer(server.id)) : setConfirming(true))}
                onBlur={() => setConfirming(false)}
                className={DANGER}
              >
                {confirming ? "Really unlink?" : "Unlink"}
              </button>
            </div>
          )}
        </div>
      )}
      {canManage && showAccess && (
        <fieldset className="mt-4">
          <legend className={`mb-2 ${LABEL}`}>Who may connect an assistant</legend>
          <div className={ROWS}>
            {members.map((m) => (
              <label
                key={m.id}
                className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-white/5 light:hover:bg-black/[0.03]"
              >
                <input
                  type="checkbox"
                  checked={m.allowed}
                  disabled={pending}
                  onChange={(e) => run(() => setServerAccess(server.id, m.id, e.target.checked))}
                  className="accent-white light:accent-[#0A0A0A]"
                />
                <span className="min-w-0 truncate text-[14px]">
                  {m.name} <span className={MUTED}>{m.email}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {error && <p className={`mt-2 ${ERROR}`}>{error}</p>}
    </li>
  );
}
