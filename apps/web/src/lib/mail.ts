import { createTransport, type Transporter } from "nodemailer";

let transport: Transporter | null = null;

/// Sends one plain-text email over SMTP, from `MAIL_FROM`. The provider is
/// `SMTP_URL` alone (`smtps://user:pass@smtp.example.com:465`), so Resend,
/// SES, Postmark or Gmail are a config change, never a code one.
///
/// With no `SMTP_URL` a dev site prints the mail to its own console, which
/// is how codes reach whoever is testing locally. A production site without
/// one throws, since a sign-up whose code goes nowhere is a dead end the
/// reader can't see.
export async function sendMail({ to, subject, text }: { to: string; subject: string; text: string }) {
  const url = process.env.SMTP_URL;
  if (!url) {
    if (process.env.NODE_ENV === "production") throw new Error("Email isn't set up on this site yet.");
    console.log(`[mail] to ${to}: ${subject}\n${text}`);
    return;
  }
  transport ??= createTransport(url);
  await transport.sendMail({ from: process.env.MAIL_FROM ?? "Dray <hello@drayhq.com>", to, subject, text });
}
