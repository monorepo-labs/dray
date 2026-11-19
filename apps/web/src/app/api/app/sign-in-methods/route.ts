import { emailSignIn } from "@/lib/auth";

/// Which ways in the desktop app's sign-in gate should offer, so turning
/// email on or off here reaches apps already shipped (#1298).
export function GET() {
  return Response.json({ email: emailSignIn });
}
