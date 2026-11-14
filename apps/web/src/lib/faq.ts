/// One question: its answer as plain text, so the same entry feeds the
/// schema.org markup, and an optional link drawn under it.
export type FaqEntry = { q: string; a: string; link?: { label: string; href: string } };

/// Google's FAQ rich result; `<` escaped so no answer can close the script tag.
/// Kept out of the client row module, which a server page cannot call into.
export function faqSchema(entries: FaqEntry[]): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entries.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  }).replace(/</g, "\\u003c");
}
