# Remote MCP — a chat front door to every Dray server

monorepo-labs/dray#858. Every Dray server — the Mac's background server, a
Linux `dray-serve` — answers the Model Context Protocol at `/mcp`, so Grok Bot,
Claude or ChatGPT can list, start, message, follow and stop sessions, answer
their cards, and read and message the server's bots, by chat or voice. The app and the iPhone app stay the place
to watch and steer; MCP is for firing work off and checking on it.

**MCP sits on top of the server, never in place of it.** Something on the
machine still spawns the agents and owns `~/.dray`; MCP only replaces the
client.

## Where it is reached

**On the serve listener, beside `/file` and `/upload`** ([serve.rs](src-tauri/src/serve.rs)
routes by request line, [mcp.rs](src-tauri/src/mcp/mcp.rs) takes `/mcp`,
`/oauth/*` and `/.well-known/oauth-*`). So it is at Remote access's public
address, which is the only way in that counts: the MCP client lives in xAI's,
Anthropic's or OpenAI's cloud, never on the phone, and Grok's docs say outright
that the server "must be reachable over the public internet". On a Mac it is
also on the local listener, so Claude Code on the same machine can use
`http://127.0.0.1:<port>/mcp`.

**One connector per machine.** `--machine` forwarding goes through the Mac
app's `host_call` and fails with the app closed, so each server answers for
itself and a Linux sandbox stays reachable on its own.

**Streamable HTTP at its plainest**: every POST answered with one JSON body, no
`Mcp-Session-Id`, no SSE stream (GET and DELETE answer 405, which the spec
allows). Nothing here is pushed, and a stateless server survives a restart
mid-conversation. Connections are not kept alive, so an idle client holds no
task in the listener's set. Revisions `2025-11-25`, `2025-06-18` and
`2025-03-26` are echoed when asked for; only the transport differs between
them.

**The origin is read off each request's `Host`**, never stored. Behind Remote
access the tunnel ends TLS in this process and passes the public `Host`
through, and OAuth's `resource` must equal the URL the reader pasted. Loopback
hosts read as `http`, everything else as `https`.

## Auth: OAuth with a pairing code

What each client can send decided this:

| Client | Auth it takes |
|---|---|
| Grok Bot | OAuth. Cursor staff: "Connectors in Grok Bot authenticate only via OAuth." |
| Claude (web, desktop, mobile) | OAuth (DCR or CIMD) or none. Static headers are a limited beta for org Owners. |
| ChatGPT developer mode | OAuth or none. Write tools ask for confirmation. |

OAuth is the one all three take. A token in the URL works through "no auth",
but Claude's docs and the MCP spec both forbid tokens in URLs, and it cannot
be revoked per client. **The serve token is never accepted on `/mcp`**: an
assistant's cloud must not hold the key to every other door.

**T3 Code ships the same shape** — OAuth whose sign-in page asks for a pairing
code — and [auth.rs](src-tauri/src/mcp/auth.rs) copies it:

- **Discovery**: `/.well-known/oauth-protected-resource[/mcp]` names this
  origin as its own authorization server; a `/mcp` call with no good token
  answers `401` with `WWW-Authenticate: Bearer resource_metadata=…` — Claude
  ignores the header on anything but a 401.
- **Registration is open DCR**, every client public (`none` at the token
  endpoint) and held to S256 PKCE. No CIMD: Claude falls back to DCR when it is
  not advertised, and nothing needs it. Claude registers afresh on every new
  connection, so clients that never got a grant are dropped after a day.
  Open to anyone who reaches the address, so what it stores is bounded: ten
  redirects of 2KB a client, a hundred clients never signed in (the oldest
  make room), twenty registrations a minute.
- **Redirects accepted**: `https:`, loopback `http:` matched on any port (RFC
  8252; Claude Code's port changes per run), and an app's own scheme —
  Grok Bot registers `cursor://anysphere.cursor-mcp/oauth/callback`, and
  servers refusing it refuse its whole registration.
- **`/oauth/authorize` is a page asking for the code.** An unknown client or
  unregistered redirect is answered on the page, never redirected to. The page
  names the client and where it sends you back, may not be framed, and carries
  no CSP `form-action`: Chrome applies it to the redirect after the post, and
  `*` does not cover `cursor://` or a loopback port.
- **Codes**: 8 characters from an alphabet with no 0/O/1/I/L/U, shown
  `ABCD-EFGH`, read case- and dash-blind. Good once, for 10 minutes. Ten wrong
  codes throw every outstanding code away.
- **Tokens**: access tokens last an hour and live in memory alone, so a
  restart costs a client one refresh, which every client does on a 401.
  Refresh tokens rotate on every use and roll 30 days forward, so an assistant
  in use never signs out. What is stored is hashes.
- **Grants** — client, name, access, created, last used — are kept in
  `<home>/mcp.json`, `0600`. One process owns a home, so a process mutex is the
  only lock. An unreadable file reads as empty: every assistant signs in again,
  which beats `/mcp` failing outright.

## Making a code

- **Settings → Servers**: each connected row's `⋯` → **Connect an
  assistant…**, This Mac included. The dialog asks that row's server
  (`mcp_pair`), so a code for a Linux box is minted on that box. The row lists
  its assistants with **Sign out** (`mcp_assistants`, `mcp_revoke`, refreshed
  on `mcp_assistants_changed`).
- **`dray server assistant add [--read-only] | ls | revoke <id>`** on a
  headless box, over the socket (protocol v15). Not `dray server pair`, which
  already prints the phone's QR.
- **Asking for a code turns Remote access on** and waits for its address, up
  to 150s: a first start provisions a certificate.

## Tools

[tools.rs](src-tauri/src/mcp/tools.rs). Read: `list_projects`,
`list_sessions`, `read_session`, `wait_for_session`, `list_bots`, `read_bot`,
`wait_for_bot`. Full adds `start_session`, `send_message`, `stop_session`,
`answer_card`, `send_to_bot`.

- **Start, send and stop take the socket's own path**
  (`orchestration::answer_here`), so a session started from a chat gets its
  worktree, its defaults, its title and its sidebar row exactly as `dray
  session new` gives them, in the server's default stance. **Never through
  `route`**, which sends a session id this index lacks on to other machines
  under their own tokens: an assistant is signed in to this server alone.
- **A read-only grant is never shown a tool it cannot call**, and is refused
  one it names anyway. Access is chosen when the code is made and carried by
  the grant for its life.
- **`wait_for_session` returns within 50s**, under the ~100s at which edges and
  clients drop a silent request — T3 Code splits its waits at the same mark.
  `timed_out: true` says to call again.
- **Status carries the open cards**, read off the hub's `Live`, since a session
  blocked on a permission card is otherwise invisible to a client nothing can
  push to. A card goes back by option id, or by question text → answer, the
  shapes the app's own card sends.
- **A read hands back the turn, not the log**: the latest prompt, the main
  thread's text since (the last 6000 characters), a tool count and the turn's
  outcome. Subagent text is left out, being no answer of the session's.
- **A tool's failure is a result with `isError`**, so the model reads it and
  tries again; only a malformed call is a protocol error.
- **A bot is read as its chat** (#944), named by name or id. Its chat is an
  ordinary session in its folder, so `read_bot` and `wait_for_bot` are
  `read_session` and `wait_for_session` on the chat's newest session. The
  latest message into the chat may be a task's report rather than the user's,
  since every task turn reports back.
- **A bot's cards are its tree's**: its chat's and every task's under it, at
  any depth, each naming the session `answer_card` takes. Its tasks run hidden
  and `list_sessions` never shows them, so this is the only way an assistant
  learns one is blocked; a task's card also ends `wait_for_bot`, as the app's
  crew column surfaces it.
- **`send_to_bot` is `dray bot send` with no sender**, so it lands as the
  user's own message, unsigned, and starts the bot's chat where it has none.
  No creating, renaming or deleting bots.

## Not built

- **CIMD**, and a `scope` vocabulary: access is the pairing's, not a scope.
- **Push.** No SSE stream, no notifications: a client polls with `wait`.
- **Other machines through one connector.** Each machine is its own.
- **Per-project grants**, and reading another machine's session through this
  one.

## Sources

- MCP authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- Claude connector auth: https://claude.com/docs/connectors/building/authentication
- Grok connectors: https://docs.x.ai/grok/connectors
- Grok Bot apps: https://docs.x.ai/grok-bot/computer-and-apps
- Grok Bot OAuth only: https://forum.cursor.com/t/grok-bot-custom-mcp-oauth-fails-before-sign-in-redirect-uri-not-allowed/171877
- ChatGPT developer mode: https://developers.openai.com/api/docs/guides/developer-mode.md
- T3 Code remote: https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md
- T3 Code `/mcp` setup: https://github.com/pingdotgg/t3code/discussions/22125
