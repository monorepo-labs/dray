/// The few boat calls Dray Cloud makes, checked against
/// https://docs.boat.dev/api/v1 and its OpenAPI file.

/// A sandbox as boat answers it. Only the fields Dray Cloud reads; boat sends
/// many more, and a partial one (a fork's or resume's answer) can lack any of
/// these but `id`.
export type Sandbox = {
  id: string;
  state?: string;
  labels?: Record<string, string>;
  subdomain?: string | null;
  createdAt?: string | null;
  stoppedAt?: string | null;
  dataExpiredAt?: string | null;
};

export class BoatError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/// One boat call. `org` sends `X-Boat-Org`, which boat documents on list and
/// create alone: a call by sandbox id needs no org.
export async function boat<T>(
  method: string,
  path: string,
  body?: unknown,
  org = false,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.BOAT_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (org && process.env.BOAT_ORG) headers["X-Boat-Org"] = process.env.BOAT_ORG;
  const res = await fetch(`${process.env.BOAT_API_URL || "https://boat.dev/api/v1"}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new BoatError(res.status, json.code ?? `http_${res.status}`, json.message ?? res.statusText);
  }
  return json as T;
}

/// Every sandbox carrying `label`, across pages.
export async function listByLabel(label: string): Promise<Sandbox[]> {
  const out: Sandbox[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ label, limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const page: { sandboxes: Sandbox[]; pageInfo?: { hasMore: boolean; nextCursor: string | null } } =
      await boat("GET", `/sandboxes?${query}`, undefined, true);
    out.push(...page.sandboxes);
    cursor = page.pageInfo?.hasMore ? page.pageInfo.nextCursor : null;
  } while (cursor);
  return out;
}
