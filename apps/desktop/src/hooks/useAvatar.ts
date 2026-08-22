import { useEffect, useState } from "react";

import { githubAvatar, gravatarUrl } from "@/lib/avatar";

/// Resolved addresses, kept for the process.
///
/// Module-level for the reason the changes caches are: a history list re-renders
/// on every session event and the same handful of authors repeat down it, so
/// the digest should be computed once per address rather than once per row per
/// render. `null` is cached too — an address that resolves to nothing is a
/// settled answer, not a retry.
const resolved = new Map<string, string | null>();

/// A picture for a commit author's email, once one is known.
///
/// Returns null until it resolves, which is the whole of the loading state:
/// [Avatar] is already drawing the initial, so there is nothing to hold back.
export function useAvatar(email: string): string | null {
  // Seeded from the cache so a repeat author paints with the picture already
  // there rather than flashing the letter first.
  const [url, setUrl] = useState<string | null>(() => resolved.get(email) ?? null);

  useEffect(() => {
    if (!email) return;

    if (resolved.has(email)) {
      setUrl(resolved.get(email) ?? null);
      return;
    }

    // Exact before probable: the noreply address names an account outright,
    // and hashing it for Gravatar would ask a second service about an address
    // that was never a real mailbox.
    const direct = githubAvatar(email);
    if (direct) {
      resolved.set(email, direct);
      setUrl(direct);
      return;
    }

    let live = true;
    void gravatarUrl(email).then((next) => {
      resolved.set(email, next);
      if (live) setUrl(next);
    });

    return () => {
      live = false;
    };
  }, [email]);

  return url;
}
