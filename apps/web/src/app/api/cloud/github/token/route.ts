import { githubToken, route } from "@/lib/cloud/cloud";

export const runtime = "nodejs";

export const POST = route("key", async (req, secrets) => githubToken(req, secrets));
