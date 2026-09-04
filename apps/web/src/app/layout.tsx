import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

// The app loads these through fontsource; here they come from next/font so the
// site self-hosts them and ships only the subset it uses.
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The headline face, and only that: one weight, one file, so it costs one
// request. Licensed per seat, not open — it stays out of the app and out of
// body text, where Geist already does the job.
const aeonik = localFont({
  src: "../fonts/AeonikPro-Medium.ttf",
  weight: "500",
  variable: "--font-aeonik",
  display: "swap",
});

const title = "Dray: run Claude Code, Codex and pi in one app";
const description =
  "Fast, feels right, runs agents in parallel — on your existing subscriptions.";

// Without a base, Next emits relative og:image URLs and most crawlers drop
// them. The domain is not known at build time, so Vercel's own is the fallback
// and NEXT_PUBLIC_SITE_URL is what pins it once there is a real one.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  ? process.env.NEXT_PUBLIC_SITE_URL
  : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  openGraph: { title, description, type: "website", siteName: "Dray" },
  twitter: { card: "summary_large_image", title, description },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The font variables go on <html>, not <body>: `@theme` resolves
    // `--font-sans: var(--font-geist-sans)` at `:root`, so a variable defined
    // one level down resolves to nothing and every utility silently falls back
    // to the system stack.
    <html
      lang="en"
      data-theme="dark"
      className={`${geistSans.variable} ${geistMono.variable} ${aeonik.variable}`}
    >
      <body className="font-sans">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
