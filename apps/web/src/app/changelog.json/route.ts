import { loadChangelog } from "@/lib/changelog";

export const dynamic = "force-static";

/// What the app's Settings → Changelog and its what's-new card read. Betas
/// included, since the app shows them to its beta channel. Open to any origin:
/// the app's webview is `tauri://localhost`.
export function GET() {
  return Response.json(loadChangelog(), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
