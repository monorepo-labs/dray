"use client";

import { useState } from "react";

import { authClient } from "@/lib/auth-client";

import { ERROR, PRIMARY } from "./styles";

/// Starts Google sign-in and lands on `next` once it comes back.
export function GoogleButton({ next }: { next: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    const { error } = await authClient.signIn.social({ provider: "google", callbackURL: next });
    // On success the browser is already leaving for Google.
    if (error) {
      setError(error.message ?? "Couldn't reach Google. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-3">
      <button type="button" onClick={start} disabled={busy} className={PRIMARY}>
        <GoogleGlyph className="size-4" />
        Continue with Google
      </button>
      {error && <p className={ERROR}>{error}</p>}
    </div>
  );
}

function GoogleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.5 5.5 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.02c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.28 14.28a7.2 7.2 0 0 1 0-4.56V6.61H1.27a12 12 0 0 0 0 10.78l4.01-3.11Z" />
      <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 1.27 6.61l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77Z" />
    </svg>
  );
}
