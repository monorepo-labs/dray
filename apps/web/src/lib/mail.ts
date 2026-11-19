/// Sends one plain-text email through Resend, from `MAIL_FROM`.
///
/// With no `RESEND_API_KEY` a dev site prints the mail to its own console,
/// which is how codes reach whoever is testing locally. A production site
/// without one throws, since a sign-up whose code goes nowhere is a dead end
/// the reader can't see.
export async function sendMail({ to, subject, text }: { to: string; subject: string; text: string }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (process.env.NODE_ENV === "production") throw new Error("Email isn't set up on this site yet.");
    console.log(`[mail] to ${to}: ${subject}\n${text}`);
    return;
  }
  const answer = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.MAIL_FROM ?? "Dray <hello@drayhq.com>", to, subject, text }),
  });
  if (!answer.ok) throw new Error(`Couldn't send email: ${answer.status} ${await answer.text()}`);
}
