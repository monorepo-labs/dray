/// What the upload Worker takes (#1479): the pure half, imported straight by
/// `test/files.test.mjs` under Node's type stripping, so it imports nothing.

const MB = 1024 * 1024;

export type Kind = {
  ext: "png" | "jpg" | "gif" | "webp" | "mp4" | "webm" | "mov";
  type: string;
  maxBytes: number;
};

const IMAGE = 20 * MB;
const VIDEO = 100 * MB;

/// The largest body taken at all, checked off Content-Length before anything
/// is read. Each kind's own cap is checked once the first bytes say which.
export const MAX_BYTES = VIDEO;

/// How many leading bytes `sniff` wants; a WebM's DocType sits a few dozen in.
export const HEAD_BYTES = 64;

// `ftyp` brands that mean a playable MP4. HEIC, AVIF and M4A share the box
// with brands of their own, so this is an allow-list, not "any ftyp".
const MP4_BRANDS = ["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "mmp4", "dash"];

/// What an upload is, read off its first bytes, or null for anything else.
/// Never the name or the declared type: a caller controls both. SVG is left
/// out on purpose, being a script carrier.
export function sniff(b: Uint8Array): Kind | null {
  const at = (off: number, sig: number[] | string) => {
    const want = typeof sig === "string" ? [...sig].map((c) => c.charCodeAt(0)) : sig;
    return b.length >= off + want.length && want.every((v, i) => b[off + i] === v);
  };
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", type: "image/png", maxBytes: IMAGE };
  if (at(0, [0xff, 0xd8, 0xff])) return { ext: "jpg", type: "image/jpeg", maxBytes: IMAGE };
  if (at(0, "GIF87a") || at(0, "GIF89a")) return { ext: "gif", type: "image/gif", maxBytes: IMAGE };
  if (at(0, "RIFF") && at(8, "WEBP")) return { ext: "webp", type: "image/webp", maxBytes: IMAGE };
  if (at(4, "ftyp")) {
    if (at(8, "qt  ")) return { ext: "mov", type: "video/quicktime", maxBytes: VIDEO };
    if (MP4_BRANDS.some((brand) => at(8, brand))) return { ext: "mp4", type: "video/mp4", maxBytes: VIDEO };
    return null;
  }
  // EBML, which Matroska shares: only a "webm" DocType (0x4282, length 0x84) is WebM.
  if (at(0, [0x1a, 0x45, 0xdf, 0xa3])) {
    for (let i = 4; i + 6 <= b.length; i++) if (at(i, [0x42, 0x82, 0x84]) && at(i + 3, "webm")) {
      return { ext: "webm", type: "video/webm", maxBytes: VIDEO };
    }
  }
  return null;
}

/// A fresh object name: 128 random bits. Not the content's hash, which would
/// need the whole body in memory before the write starts, and a Worker has
/// 128 MB for every request it serves at once.
export function keyFor(kind: Kind): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}.${kind.ext}`;
}

/// The bearer token out of an Authorization header, or null.
export function bearer(header: string | null): string | null {
  return header?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
}
