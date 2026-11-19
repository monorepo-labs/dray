import { heartbeat, route } from "@/lib/cloud/cloud";

export const runtime = "nodejs";

export const POST = route("machine", async (req) => heartbeat(req));
