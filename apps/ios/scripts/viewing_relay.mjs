// Stands in for drayhq.com's push relay under ViewingTests (#1688): counts the
// alerts a server sends, and has the server's bot reply on the test's word.
//
//   DRAY_ENDPOINT=<home>/dray.sock node viewing_relay.mjs <port> <bot>
//
// Start the server with DRAY_ACCOUNT_URL=http://127.0.0.1:<port> and a fake
// phone in its push.json: [{"handle":"dph_test","tag":"test"}].
// GET /count answers the alerts so far, GET /send has the bot reply "pong".
import { execFile } from "node:child_process";
import http from "node:http";

const [port, bot] = process.argv.slice(2);
let pushes = 0;

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url === "/api/push/send") {
        pushes += 1;
        console.log(new Date().toISOString(), "push", body);
        return res.end("{}");
      }
      if (req.url === "/count") return res.end(String(pushes));
      if (req.url === "/send") {
        return execFile("dray", ["bot", "send", bot, "Reply with the one word pong, nothing else."], (e, _out, err) => {
          res.statusCode = e ? 500 : 200;
          res.end(e ? String(err || e) : "");
        });
      }
      res.statusCode = 404;
      res.end();
    });
  })
  .listen(Number(port), "127.0.0.1");
