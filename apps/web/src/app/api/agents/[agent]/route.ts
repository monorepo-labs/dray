import { change } from "@/lib/cloud/agent-logins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ agent: string }> };

const handle = async (req: Request, { params }: Ctx) => change(req, (await params).agent);

export const PUT = handle;
export const DELETE = handle;
