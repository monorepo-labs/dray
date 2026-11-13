import { redirect } from "next/navigation";

export default async function OrgHome({ params }: { params: Promise<{ slug: string }> }) {
  redirect(`/app/${(await params).slug}/servers`);
}
