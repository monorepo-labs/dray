/// Where the sessions come from, most first. Hand-written from the analytics
/// country breakdown and stale the moment it is read — 31 countries when it was
/// last taken. The order is the only place the session counts survive: the
/// numbers themselves are nobody's business and this early they only shrink the
/// claim the row is making.
///
/// `code` is ISO 3166-1 alpha-2. Nothing draws it any more, since the flags it
/// built went with the marquee — it stays because it is the only unambiguous
/// name a country has here, and it is what `at` below can be checked against.
/// Two that are not the country's first two letters: the United Kingdom is
/// `GB` and the United Arab Emirates is `AE`.
///
/// `at` is `[latitude, longitude]`, one dot on the globe. **The capital, not a
/// centroid** — a centroid lands in the Sahara for Egypt and the Outback for
/// Australia, which is a dot where nobody is. Israel's is Tel Aviv rather than
/// the capital, which is both the tech centre and not a claim this page has
/// any business making.
export const COUNTRIES: { code: string; name: string; at: [number, number] }[] =
  [
    { code: "US", name: "United States", at: [38.9, -77.04] },
    { code: "NP", name: "Nepal", at: [27.72, 85.32] },
    { code: "BR", name: "Brazil", at: [-15.79, -47.88] },
    { code: "IE", name: "Ireland", at: [53.35, -6.26] },
    { code: "TH", name: "Thailand", at: [13.76, 100.5] },
    { code: "FR", name: "France", at: [48.86, 2.35] },
    { code: "DE", name: "Germany", at: [52.52, 13.4] },
    { code: "VN", name: "Vietnam", at: [21.03, 105.85] },
    { code: "IN", name: "India", at: [28.61, 77.21] },
    { code: "CN", name: "China", at: [39.9, 116.41] },
    { code: "GB", name: "United Kingdom", at: [51.51, -0.13] },
    { code: "JP", name: "Japan", at: [35.68, 139.69] },
    { code: "AE", name: "United Arab Emirates", at: [24.45, 54.38] },
    { code: "NL", name: "Netherlands", at: [52.37, 4.9] },
    { code: "ID", name: "Indonesia", at: [-6.21, 106.85] },
    { code: "PH", name: "Philippines", at: [14.6, 120.98] },
    { code: "SG", name: "Singapore", at: [1.35, 103.82] },
    { code: "NG", name: "Nigeria", at: [9.06, 7.49] },
    { code: "CL", name: "Chile", at: [-33.45, -70.67] },
    { code: "SA", name: "Saudi Arabia", at: [24.71, 46.68] },
    { code: "UY", name: "Uruguay", at: [-34.9, -56.16] },
    { code: "ES", name: "Spain", at: [40.42, -3.7] },
    { code: "CA", name: "Canada", at: [45.42, -75.7] },
    { code: "LV", name: "Latvia", at: [56.95, 24.11] },
    { code: "DO", name: "Dominican Republic", at: [18.49, -69.93] },
    { code: "IL", name: "Israel", at: [32.09, 34.78] },
    { code: "UZ", name: "Uzbekistan", at: [41.3, 69.24] },
    { code: "GE", name: "Georgia", at: [41.72, 44.79] },
    { code: "EG", name: "Egypt", at: [30.04, 31.24] },
    { code: "HK", name: "Hong Kong", at: [22.32, 114.17] },
    { code: "TR", name: "Turkey", at: [39.93, 32.86] },
  ];
