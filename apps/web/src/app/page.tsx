import { Closing } from "@/components/home/Closing";
import { Everywhere } from "@/components/home/Everywhere";
import { Faq } from "@/components/home/Faq";
import { Features } from "@/components/home/Features";
import { Hero } from "@/components/home/Hero";
import { Island } from "@/components/home/Island";
import { Orchestrate } from "@/components/home/Orchestrate";
import { Testimonials } from "@/components/home/Testimonials";
import { COMPANY, DOWNLOAD, REPO } from "@/lib/links";

// Hardcoded, not `siteUrl`: a preview deploy must still name the real site.
const SITE = "https://www.drayhq.com";

const SCHEMA = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", "@id": `${SITE}/#website`, name: "Dray", url: SITE, publisher: { "@id": `${SITE}/#org` } },
    {
      "@type": "Organization",
      "@id": `${SITE}/#org`,
      name: COMPANY,
      url: SITE,
      logo: `${SITE}/icon.png`,
      sameAs: [REPO, "https://x.com/dray_hq"],
    },
    {
      "@type": "SoftwareApplication",
      name: "Dray",
      url: SITE,
      description: "One Mac app for every coding agent: Claude Code, Codex, Grok Build, pi and fx.",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS",
      downloadUrl: DOWNLOAD,
      license: "https://www.apache.org/licenses/LICENSE-2.0",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@id": `${SITE}/#org` },
    },
  ],
});

export default function Home() {
  return (
    <div
      data-home
      className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased light:bg-white light:text-[#0A0A0A]"
    >
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: SCHEMA }} />
      <Hero />
      <main>
        <Orchestrate />
        <Everywhere />
        <Features />
        <Island />
        <Testimonials />
        <Faq />
      </main>
      <Closing />
    </div>
  );
}