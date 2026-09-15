"use client";

import { posthog } from "@/lib/posthog";

/// An outbound sponsor link with referral attribution and explicit click tracking.
export function SponsorLink({
  href,
  sponsor,
  destination,
  className,
  children,
}: {
  href: string;
  sponsor: string;
  destination: string;
  className: string;
  children: React.ReactNode;
}) {
  const url = new URL(href);
  url.searchParams.set("ref", "drayhq.com");
  url.searchParams.set("utm_source", "dray");
  url.searchParams.set("utm_medium", "referral");
  url.searchParams.set("utm_campaign", "sponsors");
  url.searchParams.set("utm_content", destination);

  return (
    <a
      href={url.toString()}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() =>
        posthog.capture(
          "sponsor_click",
          { sponsor, destination },
          { transport: "sendBeacon" },
        )
      }
      className={className}
    >
      {children}
    </a>
  );
}
