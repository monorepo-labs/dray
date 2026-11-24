import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keyFor, r2FromEnv, signV4, sniff } from "../src/lib/upload.ts";

/// The pure half of PR screenshot uploads (#1477), imported as TypeScript
/// through Node's type stripping. The route itself is `upload.test.mjs`.

const bytes = (...parts) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe("sniff", () => {
  test("knows the four formats by their first bytes", () => {
    assert.deepEqual(sniff(bytes([0x89], "PNG\r\n\x1a\n", [0, 0])), { ext: "png", type: "image/png" });
    assert.deepEqual(sniff(bytes([0xff, 0xd8, 0xff, 0xe0])), { ext: "jpg", type: "image/jpeg" });
    assert.deepEqual(sniff(bytes("GIF89a", [1, 0])), { ext: "gif", type: "image/gif" });
    assert.deepEqual(sniff(bytes("GIF87a")), { ext: "gif", type: "image/gif" });
    assert.deepEqual(sniff(bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ")), { ext: "webp", type: "image/webp" });
  });

  test("refuses anything else, however it is named", () => {
    assert.equal(sniff(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
    assert.equal(sniff(bytes("<html><script>alert(1)</script>")), null);
    assert.equal(sniff(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt ")), null);
    assert.equal(sniff(bytes([0, 0, 0, 0x18], "ftypmp42")), null);
    assert.equal(sniff(bytes([0x89], "PN")), null);
    assert.equal(sniff(new Uint8Array()), null);
  });
});

test("the key is the content's hash, so different bytes never share one", () => {
  const png = { ext: "png", type: "image/png" };
  const a = keyFor(bytes("one"), png);
  assert.match(a, /^[0-9a-f]{64}\.png$/);
  assert.equal(a, keyFor(bytes("one"), png));
  assert.notEqual(a, keyFor(bytes("two"), png));
});

test("the bucket comes from env, and only whole", () => {
  const env = {
    R2_ACCOUNT_ID: "acct",
    R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "shots",
    R2_PUBLIC_URL: "https://img.example.com/",
  };
  assert.deepEqual(r2FromEnv(env), {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "shots",
    accessKey: "id",
    secret: "secret",
    publicUrl: "https://img.example.com",
  });
  assert.equal(r2FromEnv({ ...env, R2_BUCKET: "" }), null);
  assert.equal(r2FromEnv({ ...env, R2_ACCOUNT_ID: undefined }), null);
  assert.equal(r2FromEnv({ ...env, R2_ACCOUNT_ID: undefined, R2_ENDPOINT: "http://127.0.0.1:9000" }).endpoint, "http://127.0.0.1:9000");
});

// AWS's own worked example for a signed PUT, from the S3 SigV4 docs ("Example: PUT Object").
test("signs AWS's published PUT example to its published signature", () => {
  const auth = signV4({
    method: "PUT",
    url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
    headers: {
      date: "Fri, 24 May 2013 00:00:00 GMT",
      "x-amz-date": "20130524T000000Z",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
      "x-amz-content-sha256": "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    },
    region: "us-east-1",
    accessKey: "AKIAIOSFODNN7EXAMPLE",
    secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  assert.equal(
    auth,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, " +
      "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
  );
});
