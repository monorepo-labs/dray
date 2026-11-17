// Whether Merge is offered for a task whose own machine is down (#1178). That
// merge runs as another machine's `gh` — This Mac's for a row, the chat's
// server's for a merge card — so it is offered only where that account can
// write to the repo, and is the one the task's machine used.

import { useSyncExternalStore } from "react";

import { channel } from "@/lib/channel";
import { slugKey } from "@/lib/pr";
import { invoke, LOCAL, qualify, type ServerId } from "@/lib/transport";
import type { IntegrationsView } from "@/types/events";

/// Each machine's `gh` login as last heard: `null` signed out. A remote's is
/// kept on disk with its rows (`ServerCache.ghLogin`), since a machine that is
/// down cannot be asked who it was.
const logins = new Map<ServerId, string | null>();

/// How long an answer stands: the backend's own cache, so a sign-in as
/// someone else is seen within it. One GitHub could not give is asked again
/// sooner, or a blip would hold Merge back for the whole window.
const ACCESS_FOR = 10 * 60_000;
const UNKNOWN_FOR = 60_000;

/// Each merging machine's answer per repo, keyed `<server> <slug>`: `null`
/// where GitHub could not be asked.
const access = new Map<string, { can: boolean | null; at: number }>();
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

function askAccess(via: ServerId, slug: string, key: string): void {
  if (asking.has(key)) return;
  asking.add(key);
  const cwd = via === LOCAL ? slugKey(slug) : qualify(`/${slugKey(slug)}`, via);
  invoke<boolean | null>("can_merge_repo", { cwd })
    .catch(() => null)
    .then((can) => {
      asking.delete(key);
      access.set(key, { can: can ?? null, at: Date.now() });
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

/// Why Merge is not offered for a task on `server`, `name` as the reader calls
/// it, whose PR is in `slug`, merged through `via` (`viaName`); `null` where
/// it is. Asks what it does not know or knows too old, holding Merge back only
/// until the first answer.
export function mergeBlock(
  server: ServerId,
  name: string,
  slug: string,
  via: ServerId = LOCAL,
  viaName = "this machine",
): string | null {
  const key = `${via} ${slug}`;
  const known = access.get(key);
  const age = known ? Date.now() - known.at : Infinity;
  if (age >= (known?.can === null ? UNKNOWN_FOR : ACCESS_FOR)) queueMicrotask(() => askAccess(via, slug, key));
  return blockReason({
    machine: name,
    merger: viaName,
    slug,
    here: logins.get(via),
    there: logins.get(server),
    can: known?.can,
  });
}

/// The rule itself. `here` is the merging machine's `gh` login (`merger`) and
/// `there` the task machine's, `undefined` where never heard; a machine whose
/// login was never heard is not held against, since its tasks were made before
/// anyone asked. `can` is the merging machine's access, `undefined` while
/// asking and `null` where GitHub could not say.
export function blockReason({
  machine,
  merger = "this machine",
  slug,
  here,
  there,
  can,
}: {
  machine: string;
  merger?: string;
  slug: string;
  here: string | null | undefined;
  there: string | null | undefined;
  can: boolean | null | undefined;
}): string | null {
  const later = `Merge once ${machine} is back.`;
  if (here && there && here !== there)
    return `${machine} used GitHub as ${there}, and ${merger} is signed in as ${here}. ${later}`;
  if (can === undefined) return `Checking whether ${merger} can merge into ${slug}…`;
  if (can === null) return `Couldn't check ${merger}'s GitHub access to ${slug}. ${later}`;
  if (!can) return `${capitalize(merger)}'s GitHub account${here ? ` (${here})` : ""} can't merge into ${slug}. ${later}`;
  return null;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
