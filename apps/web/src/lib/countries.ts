/// Where the sessions come from, most first. Hand-written from the analytics
/// country breakdown and stale the moment it is read — 22 countries when it was
/// last taken. The order is the only place the session counts survive: the
/// numbers themselves are nobody's business and this early they only shrink the
/// claim the row is making.
///
/// `code` is ISO 3166-1 alpha-2, which is what the flag emoji is built from.
/// Two that are not the country's first two letters: the United Kingdom is
/// `GB` and the United Arab Emirates is `AE`.
export const COUNTRIES: { code: string; name: string }[] = [
  { code: "NP", name: "Nepal" },
  { code: "US", name: "United States" },
  { code: "BR", name: "Brazil" },
  { code: "FR", name: "France" },
  { code: "IE", name: "Ireland" },
  { code: "IN", name: "India" },
  { code: "GB", name: "United Kingdom" },
  { code: "DE", name: "Germany" },
  { code: "NL", name: "Netherlands" },
  { code: "ID", name: "Indonesia" },
  { code: "PH", name: "Philippines" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "NG", name: "Nigeria" },
  { code: "CN", name: "China" },
  { code: "TH", name: "Thailand" },
  { code: "ES", name: "Spain" },
  { code: "JP", name: "Japan" },
  { code: "EG", name: "Egypt" },
  { code: "CL", name: "Chile" },
  { code: "SG", name: "Singapore" },
  { code: "CA", name: "Canada" },
  { code: "VN", name: "Vietnam" },
];
