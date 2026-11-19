import { createEmailClient, type EmailAdapter } from "@opencoredev/email-sdk";
import { mailgun } from "@opencoredev/email-sdk/mailgun";
import { postmark } from "@opencoredev/email-sdk/postmark";
import { resend } from "@opencoredev/email-sdk/resend";
import { sendgrid } from "@opencoredev/email-sdk/sendgrid";
import { ses } from "@opencoredev/email-sdk/ses";
import { smtp } from "@opencoredev/email-sdk/smtp";

type Client = { send: (message: { from: string; to: string; subject: string; text: string }) => Promise<unknown> };
let client: Client | null = null;

/// Sends one plain-text email from `MAIL_FROM` through the provider
/// `EMAIL_PROVIDER` names, each configured from its own env vars, so a
/// provider is a config change, never a code one.
///
/// With no `EMAIL_PROVIDER` a dev site prints the mail to its own console,
/// which is how codes reach whoever is testing locally. A production site
/// without one throws, since a sign-up whose code goes nowhere is a dead end
/// the reader can't see.
export async function sendMail({ to, subject, text }: { to: string; subject: string; text: string }) {
  if (!process.env.EMAIL_PROVIDER) {
    if (process.env.NODE_ENV === "production") throw new Error("Email isn't set up on this site yet.");
    console.log(`[mail] to ${to}: ${subject}\n${text}`);
    return;
  }
  // The SDK reports usage to its makers by default; Dray's sign-ups aren't theirs to count.
  client ??= createEmailClient({ adapters: [adapter(process.env.EMAIL_PROVIDER)], telemetry: false });
  await client.send({ from: process.env.MAIL_FROM ?? "Dray <hello@drayhq.com>", to, subject, text });
}

/// The adapter for one provider, from that provider's env vars.
function adapter(provider: string): EmailAdapter {
  const env = process.env;
  switch (provider) {
    case "resend":
      return resend({ apiKey: need("RESEND_API_KEY") });
    case "postmark":
      return postmark({ serverToken: need("POSTMARK_SERVER_TOKEN") });
    case "ses":
      return ses({ accessKeyId: need("AWS_ACCESS_KEY_ID"), secretAccessKey: need("AWS_SECRET_ACCESS_KEY"), region: need("AWS_REGION") });
    case "sendgrid":
      return sendgrid({ apiKey: need("SENDGRID_API_KEY") });
    case "mailgun":
      return mailgun({ apiKey: need("MAILGUN_API_KEY"), domain: need("MAILGUN_DOMAIN") });
    case "smtp":
      return smtp({
        host: need("SMTP_HOST"),
        port: env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: need("SMTP_PASS") } : undefined,
      });
    default:
      throw new Error(`EMAIL_PROVIDER "${provider}" isn't one of resend, postmark, ses, sendgrid, mailgun, smtp.`);
  }
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`EMAIL_PROVIDER needs ${name}.`);
  return value;
}
