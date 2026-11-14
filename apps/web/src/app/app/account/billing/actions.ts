"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { isPlanId } from "@/lib/cloud/plans";
import { portal, setOverage, subscribe } from "@/lib/cloud/subscriptions";

/// The signed-in reader. A plan is their own, so nobody else can act on it.
async function reader() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Sign in again.");
  return session.user;
}

async function billingPage() {
  const h = await headers();
  const proto = h.get("x-forwarded-proto")?.split(",")[0] ?? "http";
  return `${proto}://${h.get("x-forwarded-host") ?? h.get("host")}/app/account/billing`;
}

/// Starts Checkout for a reader without a plan, or switches a paying one's
/// plan in place. Answers an error to show, or redirects.
export async function choosePlan(plan: string): Promise<string | null> {
  if (!isPlanId(plan)) return "No such plan.";
  let url: string | null;
  try {
    const user = await reader();
    url = await subscribe({ id: user.id, name: user.name, email: user.email }, plan, await billingPage());
  } catch (e) {
    console.error("choosePlan:", e);
    return (e as Error).message;
  }
  if (url) redirect(url);
  revalidatePath("/app/account/billing");
  return null;
}

/// Sends the reader to Stripe's portal: card, invoices, cancel.
export async function openPortal(): Promise<string | null> {
  let url: string;
  try {
    url = await portal((await reader()).id, await billingPage());
  } catch (e) {
    console.error("openPortal:", e);
    return (e as Error).message;
  }
  redirect(url);
}

/// Saves the overage switch and its cap. A blank cap is no cap.
export async function saveOverage(on: boolean, cap: string): Promise<string | null> {
  const trimmed = cap.trim().replace(/^\$/, "");
  const dollars = trimmed === "" ? null : Number(trimmed);
  if (dollars !== null && !(Number.isFinite(dollars) && dollars > 0 && dollars <= 100_000)) {
    return "A cap is a dollar amount above zero, or blank for none.";
  }
  let id: string;
  try {
    id = (await reader()).id;
  } catch (e) {
    return (e as Error).message;
  }
  await setOverage(id, on, dollars === null ? null : Math.round(dollars * 100));
  revalidatePath("/app/account/billing");
  return null;
}
