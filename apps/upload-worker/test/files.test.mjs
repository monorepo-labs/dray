import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bearer, keyFor, sniff } from "../src/files.ts";

/// The pure half of the upload Worker (#1479), imported as TypeScript through
/// Node's type stripping. The Worker itself is `worker.test.mjs`.

const MB = 1024 * 1024;
const bytes = (...parts) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
const kind = (b) => {
  const k = sniff(b);
  return k && `${k.ext} ${k.type} ${k.maxBytes / MB}`;
};
// The EBML header as ffmpeg writes it, DocType at byte 24.
const ebml = (docType) =>
  bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0xf7, 0x81, 1, 0x42, 0xf2, 0x81, 4],
    [0x42, 0xf3, 0x81, 8, 0x42, 0x82, 0x80 | docType.length], docType, [0x42, 0x87, 0x81, 4]);

describe("sniff", () => {
  test("knows the four image formats by their first bytes, at 20 MB", () => {
    assert.equal(kind(bytes([0x89], "PNG\r\n\x1a\n", [0, 0])), "png image/png 20");
    assert.equal(kind(bytes([0xff, 0xd8, 0xff, 0xe0])), "jpg image/jpeg 20");
    assert.equal(kind(bytes("GIF89a", [1, 0])), "gif image/gif 20");
    assert.equal(kind(bytes("GIF87a")), "gif image/gif 20");
    assert.equal(kind(bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ")), "webp image/webp 20");
  });

  test("knows mp4, mov and webm, at 100 MB", () => {
    assert.equal(kind(bytes([0, 0, 0, 0x20], "ftypisom", [0, 0, 2, 0])), "mp4 video/mp4 100");
    assert.equal(kind(bytes([0, 0, 0, 0x18], "ftypmp42")), "mp4 video/mp4 100");
    assert.equal(kind(bytes([0, 0, 0, 0x14], "ftypqt  ")), "mov video/quicktime 100");
    assert.equal(kind(ebml("webm")), "webm video/webm 100");
  });

  test("refuses anything else, however it is named", () => {
    assert.equal(sniff(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
    assert.equal(sniff(bytes("<html><script>alert(1)</script>")), null);
    assert.equal(sniff(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt ")), null);
    // ftyp boxes that are not video: HEIC, AVIF, M4A.
    assert.equal(sniff(bytes([0, 0, 0, 0x18], "ftypheic")), null);
    assert.equal(sniff(bytes([0, 0, 0, 0x18], "ftypavif")), null);
    assert.equal(sniff(bytes([0, 0, 0, 0x18], "ftypM4A ")), null);
    // Matroska shares WebM's EBML magic; only the DocType tells them apart.
    assert.equal(sniff(ebml("matroska")), null);
    assert.equal(sniff(bytes([0x1a, 0x45, 0xdf, 0xa3])), null);
    assert.equal(sniff(bytes([0x89], "PN")), null);
    assert.equal(sniff(new Uint8Array()), null);
  });
});

test("keys are 128 random bits and the kind's extension", () => {
  const png = sniff(bytes([0x89], "PNG\r\n\x1a\n"));
  const keys = new Set(Array.from({ length: 1000 }, () => keyFor(png)));
  assert.equal(keys.size, 1000);
  for (const k of keys) assert.match(k, /^[0-9a-f]{32}\.png$/);
});

test("the bearer token comes out of the header and nothing else does", () => {
  assert.equal(bearer("Bearer gho_abc"), "gho_abc");
  assert.equal(bearer("bearer   gho_abc"), "gho_abc");
  assert.equal(bearer("Basic Zm9vOmJhcg=="), null);
  assert.equal(bearer("Bearer two words"), null);
  assert.equal(bearer(null), null);
});
