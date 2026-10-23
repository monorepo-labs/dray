import type { Metadata } from "next";

import { ServersShot } from "./ServersShot";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/// The remote servers scene alone, frozen, on a flat `?bg=` colour, for
/// taking the still the homepage draws. Shot once on black and once on white
/// at 2x, the difference between the two is the picture's transparency.
export default async function Page({ searchParams }: { searchParams: Promise<{ bg?: string }> }) {
  const { bg } = await searchParams;
  return <ServersShot bg={bg === "white" ? "#fff" : "#000"} />;
}
