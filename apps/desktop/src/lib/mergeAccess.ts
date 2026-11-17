// Whether Merge is offered here for a task whose own machine is down (#1178).
// That merge runs as this machine's `gh`, so it is offered only where that
// account can write to the repo, and is the one the task's machine used.

import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";
import { slugKey } from "@/lib/pr";
import { invoke, LOCAL, type ServerId } from "@/lib/transport";
import type { IntegrationsView } from "@/types/events";

/// Each machine's `gh` login as last heard: `null` signed out. A remote's is
/// kept on disk with its rows (`ServerCache.ghLogin`), since a machine that is
/// down cannot be asked who it was.
const logins = new Map<ServerId, string | null>();
/// This machine's answer per repo slug: `null` where GitHub could not be asked.
const access = new Map<string, boolean | null>();
const asking = new Set<string>();
let version = 0;
const changed = channel<void>();
const bump = () => {
  version++;
  changed.emit();
};

/// Reads `server`'s `gh` login, through the account the issues page draws.
export function readLogin(server: ServerId): void {
  invoke<IntegrationsView>("get_integrations", {}, server)
    .then((view) => {
      const login = view.github?.userId ?? null;
      if (logins.get(server) === login) return;
      logins.set(server, login);
      bump();
    })
    .catch(() => {});
}

/// `server`'s login as its cache kept it, unless one was heard this run.
export function seedLogin(server: ServerId, login: string | null | undefined): void {
  if (login === undefined || logins.has(server)) return;
  logins.set(server, login);
  bump();
}

/// `server`'s login as last heard, for its cache; `undefined` never heard.
export const loginOf = (server: ServerId): string | null | undefined => logins.get(server);

function askAccess(slug: string): void {
  if (asking.has(slug)) return;
  asking.add(slug);
  invoke<boolean | null>("can_merge_repo", { cwd: slugKey(slug) }, LOCAL)
    .catch(() => null)
    .then((can) => {
      asking.delete(slug);
      access.set(slug, can ?? null);
      bump();
    });
}

/// Re-renders the caller whenever a login or an access answer lands.
export function useMergeAccess(): number {
  return useSyncExternalStore(
    (listener) => changed.subscribe(listener),
    () => version,
    () => version,
  );
}

/// Why Merge is not offered from here for a task on `server`, `name` as the
/// reader calls it, whose PR is in `slug`; `null` where it is. Asks what it
/// does not know yet, and holds Merge back meanwhile.
export function mergeBlock(server: ServerId, name: string, slug: string): string | null {
  if (!access.has(slug)) queueMicrotask(() => askAccess(slug));
  return blockReason({ machine: name, slug, here: logins.get(LOCAL), there: logins.get(server), can: access.get(slug) });
}

/// The rule itself. `here` and `there` are the two `gh` logins, `undefined`
/// where never heard; a machine whose login was never heard is not held
/// against, since its tasks were made before anyone asked. `can` is this
/// machine's access, `undefined` while asking and `null` where GitHub could
/// not say.
export function blockReason({
  machine,
  slug,
  here,
  there,
  can,
}: {
  machine: string;
  slug: string;
  here: string | null | undefined;
  there: string | null | undefined;
  can: boolean | null | undefined;
}): string | null {
  const later = `Merge once ${machine} is back.`;
  if (here && there && here !== there)
    return `${machine} used GitHub as ${there}, and this machine is signed in as ${here}. ${later}`;
  if (can === undefined) return `Checking whether this machine can merge into ${slug}…`;
  if (can === null) return `Couldn't check this machine's GitHub access to ${slug}. ${later}`;
  if (!can) return `This machine's GitHub account${here ? ` (${here})` : ""} can't merge into ${slug}. ${later}`;
  return null;
}
