"use client";

import { useState, useTransition } from "react";

import { renameServer, unlinkServer } from "@/app/app/[slug]/servers/actions";

import { DANGER, ERROR, INPUT, MUTED, SECONDARY } from "./styles";

/// One linked server. Owners and admins rename it in place or unlink it;
/// unlinking asks once more on the same button.
export function ServerRow({
  server,
  canManage,
}: {
  server: { id: string; name: string; linked: string };
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
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
            <p className={`text-[13px] ${MUTED}`}>{server.linked}</p>
          </div>
          {canManage && (
            <div className="flex shrink-0 gap-2">
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
      {error && <p className={`mt-2 ${ERROR}`}>{error}</p>}
    </li>
  );
}
