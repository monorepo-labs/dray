// Stands in for APNs behind a local push relay (#1299): each alert the relay
// sends is checked like APNs would and handed to a booted simulator with
// `xcrun simctl push`, so server → relay → phone runs with no Apple key.
//
//   node fake_apns.mjs <port> <simulator udid>
//
// FAKE_APNS_KEY: the .p8 the relay signs with; its provider token is verified.
// FAKE_APNS_GONE=1 answers every send 410 Unregistered.
// FAKE_APNS_DRESS_DIR: where an alert needing the extension is saved instead (see PushTests).
import { execFile } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [port, udid] = process.argv.slice(2);
const key = process.env.FAKE_APNS_KEY && createPublicKey(process.env.FAKE_APNS_KEY);

function signed(auth) {
  const [header, claims, sig] = (auth ?? "").replace(/^bearer /, "").split(".");
  if (!key || !sig) return !key;
  return verify("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
}

const server = http2.createServer();
server.on("stream", (stream, headers) => {
  let body = "";
  stream.on("data", (d) => (body += d));
  stream.on("end", () => {
    const answer = (status, reason) => {
      stream.respond({ ":status": status });
      stream.end(reason ? JSON.stringify({ reason }) : undefined);
    };
    const payload = JSON.parse(body);
    console.log(JSON.stringify({ topic: headers["apns-topic"], collapse: headers["apns-collapse-id"], payload }));
    if (!signed(headers.authorization)) return answer(403, "InvalidProviderToken");
    if (process.env.FAKE_APNS_GONE) return answer(410, "Unregistered");
    // simctl push never runs a service extension, so an alert that needs one
    // (a question's options, a bot's face) is left for the app to dress and show.
    const dress = process.env.FAKE_APNS_DRESS_DIR;
    const kind = payload.dray?.question ? "question" : payload.dray?.bot ? "bot" : null;
    if (dress && kind) {
      writeFileSync(join(dress, `${kind}.tmp`), body);
      renameSync(join(dress, `${kind}.tmp`), join(dress, `${kind}.json`));
      return answer(200);
    }
    const file = join(tmpdir(), `fake-apns-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(payload));
    execFile("xcrun", ["simctl", "push", udid, headers["apns-topic"], file], (err) => err && console.error(err.message));
    answer(200);
  });
});
server.listen(Number(port), "127.0.0.1", () => console.log(`fake APNs on ${port}, pushing to ${udid}`));
