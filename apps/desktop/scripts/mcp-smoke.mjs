// Walks /mcp the way an assistant's cloud does: discovery, registration,
// the sign-in page with a pairing code, the code exchange with PKCE, a
// refresh, then the tools. See MCP-PLAN.md.
//
//   node scripts/mcp-smoke.mjs <mcp url> <code> [--spare <code>] [--start <project>] [--card <project>]
//
// --spare spends a second code on a wrong PKCE verifier, which must fail.
// --start starts a session there and follows it to the end of its turn.
// --card starts one that asks a question, answers the card it stops on, then
//   sends it a follow-up. Make the code with full access.
// --stop starts a long one, stops it, and expects the turn to read "stopped".
// --bot lists bots, messages the named one as the user and waits for its
//   answer; on a read-only code, checks send_to_bot is refused instead.
//   With --bot-card <project>, has the bot start a task that asks a question,
//   finds the card under the bot and answers it.
// --missing expects a project whose folder is gone to be refused by name.
// --send messages an existing session — an unstarted worktree fork, say — and
//   expects it to answer.
// A code made with --read-only is checked to be refused start_session.

import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const [url, pairing] = args;
if (!url || !pairing) {
  console.error("usage: node scripts/mcp-smoke.mjs <mcp url> <code> [--spare <code>] [--start <project>]");
  process.exit(2);
}
const step = (what, value) => console.log(`✓ ${what}`, value === undefined ? "" : JSON.stringify(value).slice(0, 400));
const fail = (what) => {
  console.error(`✗ ${what}`);
  process.exit(1);
};
const form = (body) => ({
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body),
});

// A call with no token is refused, and the refusal points at discovery.
const bare = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const challenge = bare.headers.get("www-authenticate") ?? "";
if (bare.status !== 401 || !challenge.includes("resource_metadata=")) fail(`401 with a pointer, got ${bare.status} ${challenge}`);
step("401 names its metadata");

const resource = await (await fetch(challenge.match(/resource_metadata="([^"]+)"/)[1])).json();
if (resource.resource !== url) fail(`resource ${resource.resource} ≠ ${url}`);
const server = await (await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
if (!server.code_challenge_methods_supported?.includes("S256")) fail("no S256");
step("discovery", { issuer: server.issuer });

// Registered as Grok Bot registers: a custom scheme beside https.
const redirect = "https://claude.ai/api/mcp/auth_callback";
const registered = await fetch(server.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Smoke test",
    redirect_uris: [redirect, "cursor://anysphere.cursor-mcp/oauth/callback"],
    token_endpoint_auth_method: "none",
  }),
});
if (registered.status !== 201) fail(`register ${registered.status} ${await registered.text()}`);
const client = await registered.json();
step("registered");

const evil = await fetch(
  `${server.authorization_endpoint}?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://evil.test/cb", code_challenge: "x", code_challenge_method: "S256" })}`,
  { redirect: "manual" },
);
if (evil.status !== 400 || evil.headers.get("location")) fail(`an unregistered redirect answered ${evil.status}`);
step("an unregistered redirect is refused on the page, never followed");

/// Signs in with `code`, answering the authorization code and its verifier.
async function signIn(code) {
  const verifier = randomBytes(32).toString("base64url");
  const params = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "xyz",
    resource: url,
  };
  const page = await fetch(`${server.authorization_endpoint}?${new URLSearchParams(params)}`);
  if (page.status !== 200 || !(await page.text()).includes("Smoke test")) fail(`page ${page.status}`);
  const typed = await fetch(server.authorization_endpoint, form({ ...params, pairing_code: code.toLowerCase() }));
  const back = new URL(typed.headers.get("location") ?? "about:blank");
  if (typed.status !== 302 || back.origin + back.pathname !== redirect || back.searchParams.get("state") !== "xyz") {
    fail(`sign-in answered ${typed.status} ${back}`);
  }
  return { code: back.searchParams.get("code"), verifier };
}
const exchange = (code, verifier) =>
  fetch(server.token_endpoint, form({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: url }));

const wrong = await fetch(server.authorization_endpoint, form({ client_id: client.client_id, redirect_uri: redirect, response_type: "code", code_challenge: "x", code_challenge_method: "S256", pairing_code: "ZZZZ-ZZZZ" }));
if (wrong.status !== 401) fail(`a wrong pairing code answered ${wrong.status}`);
step("a wrong pairing code is refused on the page");

if (flag("--spare")) {
  const spare = await signIn(flag("--spare"));
  const bad = await exchange(spare.code, "not-the-verifier");
  if (bad.status !== 400) fail(`a wrong verifier answered ${bad.status}`);
  step("a wrong PKCE verifier is refused");
}

const signed = await signIn(pairing);
const issued = await exchange(signed.code, signed.verifier);
if (issued.status !== 200) fail(`exchange ${issued.status} ${await issued.text()}`);
let tokens = await issued.json();
step("tokens issued", { expires_in: tokens.expires_in });
const replay = await exchange(signed.code, signed.verifier);
if (replay.status !== 400) fail(`a used code answered ${replay.status}`);
step("a code is good once");

const refreshed = await fetch(server.token_endpoint, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }));
if (refreshed.status !== 200) fail(`refresh ${refreshed.status}`);
const old = tokens.refresh_token;
tokens = await refreshed.json();
const reused = await fetch(server.token_endpoint, form({ grant_type: "refresh_token", refresh_token: old, client_id: client.client_id }));
if (reused.status !== 400) fail(`a rotated refresh token answered ${reused.status}`);
step("refresh rotates");

let id = 0;
async function rpc(method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  if (res.status !== 200) fail(`${method} answered ${res.status}`);
  const answer = await res.json();
  if (answer.error) fail(`${method}: ${answer.error.message}`);
  return answer.result;
}
const call = async (name, args = {}) => {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) fail(`${name}: ${result.content[0].text}`);
  return result.structuredContent;
};

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
step("initialize", { version: init.protocolVersion, server: init.serverInfo.name });
const note = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
if (note.status !== 202) fail(`a notification answered ${note.status}`);
const { tools } = await rpc("tools/list", {});
step("tools", tools.map((t) => t.name));
step("projects", (await call("list_projects")).projects.map((p) => p.name));
const listed = (await call("list_sessions", { limit: 3 })).sessions;
step("sessions", listed.map((s) => `${s.title} · ${s.status}`));

if (!tools.some((t) => t.name === "start_session")) {
  const refused = await rpc("tools/call", { name: "start_session", arguments: { prompt: "x" } });
  if (!refused.isError) fail("a read-only grant started a session");
  step("read-only: start_session refused", refused.content[0].text);
}

let answeredAny = false;

/// Follows a session to the end of its turn, answering each permission card
/// it stops on with the card's first option that is not a denial.
async function follow(sessionId) {
  for (let round = 0; round < 10; round++) {
    const now = await call("wait_for_session", { session_id: sessionId, seconds: 50 });
    step(`wait ${round + 1}`, { status: now.status, timed_out: now.timed_out, reply: now.reply.slice(-120), cards: now.open_cards });
    const card = now.open_cards[0];
    if (card?.kind === "permission") {
      const allow = card.options.find((o) => !/deny|no/i.test(o.label)) ?? card.options[0];
      await call("answer_card", { session_id: sessionId, request_id: card.request_id, option_id: allow.option_id });
      answeredAny = true;
      step("answered", allow.label);
      continue;
    }
    if (card?.kind === "questions") {
      const answers = Object.fromEntries(card.questions.map((q) => [q.question, q.options.at(-1)]));
      await call("answer_card", { session_id: sessionId, request_id: card.request_id, answers });
      answeredAny = true;
      step("answered", answers);
      continue;
    }
    if (!now.timed_out && !card) return now;
  }
  fail("the session never settled");
}

const project = flag("--start");
if (project) {
  const started = await call("start_session", {
    project,
    prompt: "Reply with the single word: pong. Do not use any tools.",
    title: "MCP smoke",
  });
  step("started", started);
  await follow(started.session_id);
}

const writing = flag("--card");
if (writing) {
  const started = await call("start_session", {
    project: writing,
    // A question rather than a write: `auto` asks about no ordinary write, but
    // a question card is drawn under every stance.
    prompt:
      "Use your AskUserQuestion tool to ask me one question, 'Which colour?', with the options Red and Blue. " +
      "Then reply with exactly the colour I picked and nothing else.",
    title: "MCP card smoke",
  });
  step("started", started);
  const settled = await follow(started.session_id);
  if (!answeredAny) fail("the session never stopped on a card to answer");
  if (!/blue/i.test(settled.reply)) fail(`the answer did not reach the agent: ${settled.reply}`);
  const sent = await call("send_message", { session_id: started.session_id, message: "Reply with the single word: again." });
  step("follow-up sent", sent);
  const after = await follow(started.session_id);
  if (!/again/i.test(after.reply)) fail(`the follow-up was not answered: ${after.reply}`);
  step("follow-up answered", { first: settled.reply.slice(-60), second: after.reply });
}
const stopping = flag("--stop");
if (stopping) {
  const started = await call("start_session", {
    project: stopping,
    prompt: "Run exactly this shell command and nothing else: for i in $(seq 120); do echo $i; sleep 1; done",
    title: "MCP stop smoke",
  });
  if (started.status !== "in_progress") fail(`start answered ${started.status}`);
  step("started, in_progress");
  await new Promise((r) => setTimeout(r, 10_000));
  await call("stop_session", { session_id: started.session_id });
  let now;
  for (let i = 0; i < 15 && !now?.turn; i++) {
    now = await call("read_session", { session_id: started.session_id });
    if (!now.turn) await new Promise((r) => setTimeout(r, 1000));
  }
  if (now?.turn?.outcome !== "stopped") fail(`a stop read as ${JSON.stringify(now?.turn)}`);
  step("stop reads as stopped", now.turn);
}

const sendTo = flag("--send");
if (sendTo) {
  await call("send_message", { session_id: sendTo, message: "Reply with the single word: forked." });
  const after = await follow(sendTo);
  if (!/forked/i.test(after.reply)) fail(`the session did not answer: ${after.reply}`);
  step("an existing session answered", after.reply);
}

const botName = flag("--bot");
if (botName) {
  const listed = (await call("list_bots")).bots;
  step("bots", listed.map((b) => `${b.name} · working=${b.working} waiting=${b.waiting}`));
  if (!listed.some((b) => b.name.toLowerCase() === botName.toLowerCase())) fail(`no bot ${botName} in list_bots`);
  if (!tools.some((t) => t.name === "send_to_bot")) {
    const refused = await rpc("tools/call", { name: "send_to_bot", arguments: { bot: botName, message: "x" } });
    if (!refused.isError) fail("a read-only grant messaged a bot");
    step("read-only: send_to_bot refused", refused.content[0].text);
  } else {
    const sent = await call("send_to_bot", { bot: botName, message: "Reply with the single word: beep. Do not use any tools." });
    step("sent to bot", sent);
    let now;
    for (let round = 0; round < 10; round++) {
      now = await call("wait_for_bot", { bot: botName, seconds: 50 });
      step(`bot wait ${round + 1}`, { status: now.status, timed_out: now.timed_out, reply: now.reply?.slice(-120), cards: now.open_cards });
      if (!now.timed_out) break;
    }
    if (!/beep/i.test(now.reply ?? "")) fail(`the bot did not answer: ${now.reply}`);
    if (!/beep/i.test(now.last_prompt ?? "")) fail(`the message did not land as the user's: ${now.last_prompt}`);
    step("bot answered", { last_prompt: now.last_prompt, reply: now.reply });
  }
  const unknown = await rpc("tools/call", { name: "read_bot", arguments: { bot: "no-such-bot" } });
  if (!unknown.isError) fail("an unknown bot read without error");
  step("an unknown bot is an isError result", unknown.content[0].text);
}

const taskProject = flag("--bot-card");
if (botName && taskProject) {
  await call("send_to_bot", {
    bot: botName,
    message:
      `Start one task with \`dray session new --project ${taskProject} "<prompt>"\`, where the prompt tells it: ` +
      "use your AskUserQuestion tool to ask one question, 'Which colour?', with the options Red and Blue, then reply with exactly the colour picked. " +
      "Then reply to me with the single word: started.",
  });
  let card;
  for (let round = 0; round < 30 && !card; round++) {
    const now = await call("wait_for_bot", { bot: botName, seconds: 50 });
    card = now.open_cards.find((c) => c.kind === "questions" && c.session_id);
    step(`bot card wait ${round + 1}`, { status: now.status, timed_out: now.timed_out, cards: now.open_cards.length });
    if (!card) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!card) fail("the task's card never showed under its bot");
  const listedCard = (await call("list_bots")).bots.find((b) => b.name.toLowerCase() === botName.toLowerCase());
  if (!listedCard.waiting || !listedCard.open_cards.length) fail("list_bots did not mark the bot waiting");
  step("task card under the bot", { session: card.session_title, questions: card.questions });
  const answers = Object.fromEntries(card.questions.map((q) => [q.question, q.options.at(-1)]));
  await call("answer_card", { session_id: card.session_id, request_id: card.request_id, answers });
  const task = await follow(card.session_id);
  if (!/blue/i.test(task.reply)) fail(`the task did not get the answer: ${task.reply}`);
  step("the task answered", task.reply);
}

const missing = flag("--missing");
if (missing) {
  const refused = await rpc("tools/call", { name: "start_session", arguments: { project: missing, prompt: "x" } });
  if (!refused.isError || !/no longer exists/.test(refused.content[0].text)) fail(`a missing folder answered ${refused.content[0].text}`);
  step("a missing folder is named", refused.content[0].text);
}

// For checking a revoke by hand: the tokens, and the client they belong to.
if (args.includes("--tokens")) console.log(JSON.stringify({ ...tokens, client_id: client.client_id, token_endpoint: server.token_endpoint }));
console.log("\nAll good.");
