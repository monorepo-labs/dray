"use client";

import { useState, useTransition } from "react";

import { DANGER, ERROR, MUTED } from "./styles";

/// One credential acting for the reader, cut off from its row. Asks once
/// more on the same button, as unlinking a server does.
export function RevokeRow({
  title,
  detail,
  verb,
  revoke,
}: {
  title: string;
  detail: string;
  verb: string;
  revoke: () => Promise<string | null>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-[15px]">{title}</p>
          <p className={`truncate text-[13px] ${MUTED}`}>{detail}</p>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => (confirming ? start(async () => setError(await revoke())) : setConfirming(true))}
          onBlur={() => setConfirming(false)}
          className={`shrink-0 ${DANGER}`}
        >
          {confirming ? `Really ${verb.toLowerCase()}?` : verb}
        </button>
      </div>
      {error && <p className={`mt-2 ${ERROR}`}>{error}</p>}
    </li>
  );
}
