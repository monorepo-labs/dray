//! Which accounts each agent CLI is signed in as, asked of the CLIs themselves.
//!
//! Every one of the four keeps its own credential store and answers a status
//! question on the command line, so the Accounts tab is four probes and a row
//! each — all of them under 250ms, which is why nothing here is cached: the
//! reader is on that page because they are about to change a login.
//!
//! **No CLI here exposes a headless OAuth flow.** `claude auth login`,
//! `codex login`, `fx login` and pi's `/login` are all interactive, so an OAuth
//! choice opens a terminal and the page re-reads afterwards. What can be done
//! without one is an **API key**, and only where the CLI has a way to take it:
//! `codex login --with-api-key` reads one off stdin, and pi's own store is a
//! JSON file this module writes. Everything else is a terminal.
//!
//! Dray keeps no copy of any key. A pasted one is handed to the CLI's own store
//! and dropped — a second store here would be free to disagree with the one the
//! CLI actually reads.

use crate::binpath;
use crate::harness::{agent_path, Harness};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use ts_rs::TS;

/// How long any one probe may take before its row reads as unknown.
///
/// Generous against the ~250ms all four measure at, because the cost of being
/// wrong is asymmetric: a slow machine drawing "couldn't ask" about a perfectly
/// good login is worse than a tab that takes a moment. A hung CLI still cannot
/// hold the tab, since every probe runs under this.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// fx's providers, which are a closed set of three and spelled two ways.
///
/// `fx login`/`fx logout` take the short name; `fx status --json` reports the
/// long one in `connected_providers`. Both are needed and neither can be
/// derived from the other, so they are written down together — the pair is what
/// a test pins.
const FX_PROVIDERS: [(&str, &str, &str); 3] = [
    ("vercel", "vercel-ai-gateway", "Vercel AI Gateway"),
    ("codex", "codex", "Codex"),
    ("grok", "grok", "Grok"),
];

/// One of pi's providers: its id, its name, and **which ways in it actually
/// has**.
///
/// The last two are the whole reason this is a table rather than a list of
/// names. **Six of pi's providers have OAuth and the rest do not**, and
/// `openai-codex` has OAuth and *no* key — so offering the same pair on every
/// row, which the first draft did, drew a sign-in button for thirty providers
/// that have none and a key field for the one that cannot take one. Both are
/// controls that end in a refusal.
///
/// Read out of pi's own provider definitions (`auth:{apiKey:…,oauth:…}`),
/// which is a compile-time seed and not an authority: pi publishes no list —
/// `get_available_models` names only what is configured and its rpc has no
/// providers method — so **the reader can type past this** and `pi auth check`
/// decides, answering `provider_not_found` for a name pi does not know. The
/// first draft guessed twelve names and got `moonshot` wrong (it is
/// `moonshotai`), which is exactly why the validator rather than the table is
/// what refuses.
///
/// A row with neither way in is one whose credential is *structured* rather
/// than a key — Bedrock's AWS pair, Vertex's service account, Cloudflare's
/// account-and-token. [`providers_of`] drops those from the offer rather than
/// drawing a key field that would write something pi cannot use, and they stay
/// here so a row for one still draws its name.
struct PiProvider {
    id: &'static str,
    label: &'static str,
    oauth: bool,
    api_key: bool,
}

const fn pi_entry(id: &'static str, label: &'static str, oauth: bool, api_key: bool) -> PiProvider {
    PiProvider {
        id,
        label,
        oauth,
        api_key,
    }
}

const PI_PROVIDERS: [PiProvider; 39] = [
    pi_entry("amazon-bedrock", "Amazon Bedrock", false, false),
    pi_entry("ant-ling", "Ant Ling", false, true),
    pi_entry("anthropic", "Anthropic", true, true),
    pi_entry("azure-openai-responses", "Azure OpenAI", false, true),
    pi_entry("baseten", "Baseten", false, true),
    pi_entry("cerebras", "Cerebras", false, true),
    pi_entry("cloudflare-ai-gateway", "Cloudflare AI Gateway", false, false),
    pi_entry("cloudflare-workers-ai", "Cloudflare Workers AI", false, false),
    pi_entry("deepseek", "DeepSeek", false, true),
    pi_entry("fireworks", "Fireworks", false, true),
    pi_entry("github-copilot", "GitHub Copilot", true, true),
    pi_entry("google", "Google", false, true),
    pi_entry("google-vertex", "Google Vertex AI", false, false),
    pi_entry("groq", "Groq", false, true),
    pi_entry("huggingface", "Hugging Face", false, true),
    pi_entry("kimi-coding", "Kimi For Coding", true, true),
    pi_entry("minimax", "MiniMax", false, true),
    pi_entry("minimax-cn", "MiniMax CN", false, true),
    pi_entry("mistral", "Mistral", false, true),
    pi_entry("moonshotai", "Moonshot AI", false, true),
    pi_entry("moonshotai-cn", "Moonshot AI CN", false, true),
    pi_entry("nvidia", "NVIDIA", false, true),
    pi_entry("openai", "OpenAI", false, true),
    // OAuth and nothing else — a ChatGPT subscription, which is not a thing
    // anybody holds a key for.
    pi_entry("openai-codex", "OpenAI Codex", true, false),
    pi_entry("opencode", "OpenCode Zen", false, true),
    pi_entry("opencode-go", "OpenCode Go", false, true),
    pi_entry("openrouter", "OpenRouter", true, true),
    pi_entry("qwen-token-plan", "Qwen Token Plan", false, true),
    pi_entry("qwen-token-plan-cn", "Qwen Token Plan CN", false, true),
    pi_entry("qwen-token-plan-individual", "Qwen Token Plan Individual", false, true),
    pi_entry("together", "Together", false, true),
    pi_entry("vercel-ai-gateway", "Vercel AI Gateway", false, true),
    pi_entry("xai", "xAI", true, true),
    pi_entry("xiaomi", "Xiaomi", false, true),
    pi_entry("xiaomi-token-plan-ams", "Xiaomi Token Plan AMS", false, true),
    pi_entry("xiaomi-token-plan-cn", "Xiaomi Token Plan CN", false, true),
    pi_entry("xiaomi-token-plan-sgp", "Xiaomi Token Plan SGP", false, true),
    pi_entry("zai", "Z.AI", false, true),
    pi_entry("zai-coding-cn", "Z.AI Coding CN", false, true),
];

/// pi's entry for a provider, where this build knows one.
fn pi_known(provider: &str) -> Option<&'static PiProvider> {
    PI_PROVIDERS.iter().find(|entry| entry.id == provider)
}

/// A way of signing in, as an offer the reader picks between.
///
/// The axis every one of these CLIs has and none of them calls the same thing:
/// Codex is ChatGPT-or-API-key, Claude is subscription-or-Console, pi and fx
/// are OAuth-or-key per provider. Modelled once here so the tab asks one
/// question rather than four differently-shaped ones.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct AuthOption {
    /// Closed per harness — `add_account` matches on it and refuses anything
    /// else, which is what keeps a frontend string out of a command line.
    pub id: String,
    pub label: String,
    /// Whether taking it means pasting a key here. `false` means the reader
    /// runs [`command`](Self::command) themselves.
    pub needs_key: bool,
    /// The command to run, spelled the way the reader would type it, for every
    /// option Dray cannot carry out.
    ///
    /// **Shown, copyable, and run by [`run_agent_login`] on the reader's say
    /// so.** Every one of these is a literal in [`auth_options`], which is what
    /// makes running it safe: the frontend names an option id and the string is
    /// looked up here, so nothing anybody typed reaches a command line. The
    /// string is still drawn, since a reader is owed sight of what a button is
    /// about to run in their shell.
    pub command: Option<String>,
    /// What the reader should know before picking it — where it bills, or what
    /// they will have to do once they are in the terminal.
    pub hint: Option<String>,
}

/// A provider to offer in the Add-account flow.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct ProviderChoice {
    pub id: String,
    pub label: String,
}

/// One credential a harness holds, which for two of them is one of several.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// The provider this row is about, in the CLI's own spelling — what
    /// `fx login <it>` takes and what `pi auth check --provider <it>` answers
    /// for. `None` for the two harnesses that hold one credential and need no
    /// name for it.
    pub provider: Option<String>,
    /// What to call it on screen. Separate from `provider` because the wire
    /// spelling is not a label: `vercel-ai-gateway` is a slug, not a heading.
    pub label: String,
    pub state: AccountState,
    /// Who this is — an email and plan for Claude, the CLI's own sentence for
    /// Codex — or why it isn't anybody.
    pub detail: Option<String>,
    /// **How** it is signed in, where the CLI says: "ChatGPT subscription",
    /// "API key", "OAuth". Drawn separately from `detail` because it is the
    /// thing the ⋯ menu offers to change, so a reader comparing the row to the
    /// menu should not have to find it inside a sentence.
    pub auth_type: Option<String>,
    /// Whether this one can be signed out without a terminal. Per *account*
    /// rather than per harness, since fx signs out one provider at a time where
    /// Claude and Codex sign out the only credential they hold.
    pub can_sign_out: bool,
    /// Whether there is more than one way to hold this credential.
    ///
    /// What the ⋯ menu's wording turns on: with one method there is nothing to
    /// *change*, so offering "change sign-in method" on fx's Codex or Grok rows
    /// — a subscription and nothing else — named an action the form cannot
    /// carry out. Those rows say **Reauthorize** instead, which is the thing a
    /// reader with an expired token actually wants and the only thing one
    /// method allows.
    pub can_change_method: bool,
}

/// Whether a credential will serve.
///
/// Three-valued rather than a bool, and the third is the one that earns it: a
/// probe that could not run at all must not read as *signed out*, which would
/// send the reader to fix a login that was never broken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum AccountState {
    LoggedIn,
    LoggedOut,
    Unknown,
}

/// One harness's whole answer: can it run here, who is it, and what may be added.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct AgentAccounts {
    pub harness: Harness,
    pub label: String,
    /// Whether there is a CLI to ask at all. `false` leaves `accounts` empty —
    /// the tab draws the install cure there instead, which is the same
    /// distinction [`crate::AgentAvailability`] makes for the composer.
    pub installed: bool,
    pub accounts: Vec<Account>,
    /// Providers the Add-account flow offers. Empty for a harness holding one
    /// credential, and for pi it is a shortlist the reader may type past — see
    /// [`PI_PROVIDERS`].
    pub providers: Vec<ProviderChoice>,
    /// Whether a provider outside `providers` may be typed. pi alone, since pi
    /// is the only one whose list this build cannot know the whole of.
    pub provider_freeform: bool,
    pub login_hint: Option<String>,
    /// Why the probe said nothing, where it failed outright. Drawn under the
    /// rows rather than swallowed, or a harness with no accounts and no
    /// sentence reads as one nobody has ever signed into.
    pub error: Option<String>,
}

/// Every harness, asked at once.
///
/// Concurrent because they are independent and serial would spend the sum of
/// four spawns on an answer that costs the slowest one.
pub async fn all() -> Vec<AgentAccounts> {
    futures_util::future::join_all(Harness::ALL.map(one)).await
}

async fn one(harness: Harness) -> AgentAccounts {
    let installed = binpath::agent_installed(harness).await;

    let (accounts, error) = if installed {
        match probe(harness).await {
            Ok(accounts) => (accounts, None),
            // `{:#}` rather than `to_string`, which on an anyhow chain prints
            // the outermost context alone — the same trap the dictation
            // failure message documents.
            Err(err) => (Vec::new(), Some(format!("{err:#}"))),
        }
    } else {
        (Vec::new(), None)
    };

    AgentAccounts {
        harness,
        label: harness.label().to_string(),
        installed,
        accounts,
        providers: providers_of(harness),
        provider_freeform: harness == Harness::Pi,
        login_hint: harness.login_hint().map(str::to_string),
        error,
    }
}

/// What the Add-account flow offers to sign into.
///
/// pi's list drops the providers whose credential is *structured* rather than a
/// key or a sign-in — see [`PI_PROVIDERS`] — since there is no way in this tab
/// could offer for one, and a row that can be picked and then offers no method
/// is a dead end two clicks deep.
pub fn providers_of(harness: Harness) -> Vec<ProviderChoice> {
    let choice = |id: &str, label: &str| ProviderChoice {
        id: id.to_string(),
        label: label.to_string(),
    };

    match harness {
        Harness::Fx => FX_PROVIDERS
            .iter()
            .map(|(arg, _, label)| choice(arg, label))
            .collect(),
        Harness::Pi => PI_PROVIDERS
            .iter()
            .filter(|entry| entry.oauth || entry.api_key)
            .map(|entry| choice(entry.id, entry.label))
            .collect(),
        // One credential, so there is nothing to pick between.
        Harness::ClaudeCode | Harness::Codex | Harness::Other(_) => Vec::new(),
    }
}

/// The ways into one harness — and, where it has several credentials, into one
/// of its providers.
///
/// The list is the whole of what `add_account` will accept, so a frontend
/// cannot ask for a flow this build did not offer. It is also **per provider**
/// wherever the harness is, which is the correction that matters most here: pi
/// offers OAuth on six of its providers and a key on all but one, and drawing
/// the same pair on every row promised a sign-in thirty of them do not have.
pub fn auth_options(harness: Harness, provider: Option<&str>) -> Vec<AuthOption> {
    let option = |id: &str, label: &str, command: Option<&str>, hint: Option<&str>| AuthOption {
        id: id.to_string(),
        label: label.to_string(),
        needs_key: command.is_none(),
        command: command.map(str::to_string),
        hint: hint.map(str::to_string),
    };

    match harness {
        // `claude auth login` takes `--claudeai` (its default) or `--console`,
        // and **both are browser flows** — there is no key form — so neither
        // offers a field. Worth listing as two anyway: they bill differently,
        // which is exactly the thing this control exists to make visible.
        Harness::ClaudeCode => vec![
            option(
                "claudeai",
                "Claude subscription",
                Some("claude auth login"),
                None,
            ),
            option(
                "console",
                "Anthropic Console",
                Some("claude auth login --console"),
                Some("Billed per token against your Console account."),
            ),
        ],
        // The one CLI of the four with a real non-interactive key path, which
        // is why its second option takes a field where every other terminal
        // route here takes a command.
        Harness::Codex => vec![
            option("chatgpt", "ChatGPT subscription", Some("codex login"), None),
            option(
                "api_key",
                "OpenAI API key",
                None,
                Some("Billed per token. Replaces the ChatGPT sign-in until you sign in again."),
            ),
        ],
        // pi: whatever *this* provider actually has. Its OAuth is a slash
        // command inside the TUI rather than a subcommand, so the command is
        // `pi` and the hint carries the rest — a reader dropped into a TUI with
        // no idea what to type is a cure that does not cure.
        Harness::Pi => {
            let entry = provider.and_then(pi_known);
            let mut options = Vec::new();

            // An unknown provider is one the reader typed and pi may well
            // know — this build simply has no entry for it — so both ways in
            // are offered rather than none. Over-offering costs a refusal from
            // pi; under-offering makes a provider added after this build
            // unreachable, which is the same reading the shortlist takes.
            if entry.is_none_or(|entry| entry.oauth) {
                options.push(option(
                    "oauth",
                    "Sign in with the provider",
                    Some("pi"),
                    Some("Type /login in pi, then pick the provider."),
                ));
            }
            if entry.is_none_or(|entry| entry.api_key) {
                options.push(option("api_key", "API key", None, None));
            }
            options
        }
        // fx's gateway key has a setup command of its own; the other two are
        // sign-ins and nothing else. `fx setup` takes no flags and asks for the
        // key itself, so even that half is a command rather than a field.
        Harness::Fx if provider == Some("vercel") => vec![
            option("oauth", "Vercel account", Some("fx login vercel"), None),
            option(
                "gateway_key",
                "AI Gateway key",
                Some("fx setup"),
                Some("fx asks for the key itself."),
            ),
        ],
        Harness::Fx => vec![option(
            "oauth",
            "Sign in",
            Some(match provider {
                Some("codex") => "fx login codex",
                Some("grok") => "fx login grok",
                _ => "fx login",
            }),
            None,
        )],
        Harness::Other(_) => Vec::new(),
    }
}

async fn probe(harness: Harness) -> anyhow::Result<Vec<Account>> {
    match harness {
        Harness::ClaudeCode => claude().await,
        Harness::Codex => codex().await,
        Harness::Pi => pi().await,
        Harness::Fx => fx().await,
        // Nothing to ask: this build cannot name the CLI, let alone drive it.
        Harness::Other(_) => Ok(Vec::new()),
    }
}

/// What a CLI said, on whichever stream it chose to say it.
struct Said {
    ok: bool,
    out: String,
    err: String,
}

/// Runs a CLI and hands back both streams, whatever it exited with.
///
/// Two things here are measured rather than assumed, and each cost a wrong row
/// before it was. **The status is not checked**: a signed-out CLI reports
/// through a non-zero exit with the answer still on a stream, so treating
/// non-zero as failure turns "not signed in" into "could not ask". And **both
/// streams come back**, because `codex login status` writes its one sentence to
/// **stderr** — stdout is empty — where the other three answer on stdout. A
/// reader of stdout alone gets a correct yes/no from Codex and no identity at
/// all, which is the half of the row worth having.
async fn run(harness: Harness, args: &[&str]) -> anyhow::Result<Said> {
    let bin = binpath::agent_binary(harness).await;
    let output = tokio::time::timeout(
        PROBE_TIMEOUT,
        Command::new(&bin)
            .args(args)
            .env("PATH", agent_path(&bin))
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("{} took too long to answer", harness.label()))??;

    Ok(Said {
        ok: output.status.success(),
        out: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        err: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeStatus {
    #[serde(default)]
    logged_in: bool,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    org_name: Option<String>,
    #[serde(default)]
    subscription_type: Option<String>,
    /// `claude.ai` for a subscription, `apiKey` for Console billing — the two
    /// bill differently, which is why it is drawn as the row's auth type rather
    /// than buried in the identity line.
    #[serde(default)]
    auth_method: Option<String>,
}

/// `claude auth status --json`, the richest of the four.
///
/// Every field is optional even though the installed CLI sends them all: this
/// is somebody else's JSON, and a field that moved must cost the detail line
/// rather than the row.
async fn claude() -> anyhow::Result<Vec<Account>> {
    let stdout = run(Harness::ClaudeCode, &["auth", "status", "--json"]).await?.out;
    let status: ClaudeStatus = serde_json::from_str(&stdout)
        .map_err(|err| anyhow::anyhow!("couldn't read what claude said about its login: {err}"))?;

    // Email first, then the plan, then whose org. The reader asking this is
    // nearly always checking they are not on the other account.
    let detail = [status.email, status.subscription_type, status.org_name]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");

    Ok(vec![Account {
        provider: None,
        label: "Anthropic".to_string(),
        state: if status.logged_in {
            AccountState::LoggedIn
        } else {
            AccountState::LoggedOut
        },
        detail: (!detail.is_empty()).then_some(detail),
        auth_type: status.auth_method.map(|method| match method.as_str() {
            "claude.ai" => "Claude subscription".to_string(),
            "apiKey" => "Anthropic Console".to_string(),
            other => other.to_string(),
        }),
        // `claude auth logout` is a real subcommand, listed by `claude auth
        // --help` beside `login` and `status`.
        can_sign_out: status.logged_in,
        can_change_method: auth_options(Harness::ClaudeCode, None).len() > 1,
    }])
}

/// `codex login status`, which answers in prose and nothing else.
///
/// There is no `--json` (measured: the flag is refused), so the sentence *is*
/// the answer and it is passed through rather than reworded.
///
/// The **auth type comes off disk**, not out of that sentence: `~/.codex/
/// auth.json` carries `auth_mode` beside an `OPENAI_API_KEY` slot, which is the
/// field `login --with-api-key` writes — so it is the honest answer to "what
/// will saving a key change", and the row says it before the reader finds out
/// by being billed differently.
async fn codex() -> anyhow::Result<Vec<Account>> {
    let said = run(Harness::Codex, &["login", "status"]).await?;
    // **stderr first**, measured: `codex login status` leaves stdout empty and
    // writes "Logged in using ChatGPT" to stderr. stdout is kept as the
    // fallback rather than dropped, since a CLI moving its own output back to
    // the ordinary stream should cost nothing.
    let text = if said.err.is_empty() { said.out } else { said.err };
    let state = codex_state(said.ok, &text);
    let signed_in = state == AccountState::LoggedIn;

    Ok(vec![Account {
        provider: None,
        label: "OpenAI".to_string(),
        state,
        detail: text.lines().next().filter(|line| !line.is_empty()).map(str::to_string),
        auth_type: signed_in.then(codex_auth_mode).flatten(),
        can_sign_out: signed_in,
        can_change_method: auth_options(Harness::Codex, None).len() > 1,
    }])
}

/// What Codex's own answer means, in three states rather than two.
///
/// A signed-out `codex` exits non-zero *and* says so in words, so both halves
/// are read — and the third state is what the pair buys. **A non-zero exit that
/// does not say "not logged in" is `Unknown`**, not signed out: a config error
/// or a broken install would otherwise report a perfectly good account as
/// missing and send the reader off to replace a credential that was never the
/// problem. Same reading the dot's third colour exists for.
fn codex_state(ok: bool, text: &str) -> AccountState {
    if text.to_lowercase().contains("not logged in") {
        AccountState::LoggedOut
    } else if ok {
        AccountState::LoggedIn
    } else {
        AccountState::Unknown
    }
}

/// How Codex is signed in, read off its own credential file.
///
/// Read rather than asked because `codex login status` names the *account* kind
/// in prose and `auth_mode` is the field that actually decides, and it is the
/// one a saved key moves. Only the mode is read — the tokens beside it are not
/// touched and never leave this function.
fn codex_auth_mode() -> Option<String> {
    let raw = std::fs::read_to_string(std::env::home_dir()?.join(".codex/auth.json")).ok()?;
    let mode = serde_json::from_str::<Value>(&raw)
        .ok()?
        .get("auth_mode")?
        .as_str()?
        .to_string();

    Some(match mode.as_str() {
        "chatgpt" => "ChatGPT subscription".to_string(),
        "apikey" | "api_key" => "OpenAI API key".to_string(),
        other => other.to_string(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiCheck {
    status: String,
    #[serde(default)]
    auth_type: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

/// pi, one row per provider it already serves models for.
///
/// **No provider table decides what is *drawn* here**, for the reason
/// `pi/models.rs` gives about its own list: which providers exist is the
/// reader's business, not a constant this build could keep current. So the rows
/// come from the model list Dray already reads. [`PI_PROVIDERS`] is a different
/// question — what to *offer* — and is a shortlist rather than an authority.
///
/// The model list alone would answer "is it signed in" by omission. It is asked
/// anyway, per provider, because `pi auth check` says *what kind* of credential
/// and, for a provider that is configured but expired, why it will not serve —
/// which the list cannot say at all.
async fn pi() -> anyhow::Result<Vec<Account>> {
    let models = crate::harness::pi::models::list().await;
    let mut providers: Vec<String> = crate::harness::pi::models::by_provider(&models)
        .into_iter()
        .map(|(provider, _)| provider)
        .collect();

    // A key this module wrote is a credential pi holds whether or not it serves
    // a model list yet, so the store is folded in — without it, pasting a key
    // and watching no row appear reads as the save having failed.
    for provider in pi_store_providers() {
        if !providers.contains(&provider) {
            providers.push(provider);
        }
    }

    Ok(futures_util::future::join_all(providers.into_iter().map(pi_provider)).await)
}

async fn pi_provider(provider: String) -> Account {
    let checked = pi_check(&provider).await;

    let (state, auth_type, detail) = match checked {
        Some(check) if check.status == "ready" => (
            AccountState::LoggedIn,
            check.auth_type.map(|kind| match kind.as_str() {
                "oauth" => "OAuth".to_string(),
                "api_key" | "apiKey" => "API key".to_string(),
                other => other.to_string(),
            }),
            None,
        ),
        Some(check) => (AccountState::LoggedOut, None, check.reason.map(humanize)),
        // The model list named it, so pi serves it; the check is what could not
        // be read. Unknown rather than signed out, since the stronger claim is
        // the one contradicted by the very list this name came from.
        None => (AccountState::Unknown, None, None),
    };

    Account {
        label: pi_label(&provider),
        // Signing out is removing pi's own record of it, which this module
        // wrote the other half of — so it is offered only where there is a
        // record to remove.
        can_sign_out: state == AccountState::LoggedIn && pi_store_providers().contains(&provider),
        can_change_method: auth_options(Harness::Pi, Some(&provider)).len() > 1,
        provider: Some(provider),
        state,
        auth_type,
        detail,
    }
}

/// `pi auth check` for one provider, parsed.
///
/// `--no-refresh`, or reading the page silently renews the reader's OAuth token
/// as a side effect of looking at it. A stale credential should be reported as
/// stale; refreshing it is what the next turn is for.
async fn pi_check(provider: &str) -> Option<PiCheck> {
    run(
        Harness::Pi,
        &["auth", "check", "--provider", provider, "--json", "--no-refresh"],
    )
    .await
    .ok()
    .and_then(|said| serde_json::from_str::<PiCheck>(&said.out).ok())
}

/// The shortlist's name for a provider, or its own id.
///
/// Falling through to the id is what keeps the shortlist from being an
/// authority: a provider pi serves that nobody here listed draws its own name
/// rather than going missing.
fn pi_label(provider: &str) -> String {
    pi_known(provider).map_or_else(|| provider.to_string(), |entry| entry.label.to_string())
}

/// `credentials_not_configured` → `Credentials not configured`.
///
/// pi answers in snake case, which reads as a log line rather than as a
/// sentence about the reader's own account.
fn humanize(reason: String) -> String {
    let spaced = reason.replace('_', " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => spaced,
    }
}

#[derive(Deserialize)]
struct FxStatus {
    #[serde(default)]
    connected_providers: Vec<String>,
    /// Which one is actually serving, in fx's own words ("Grok subscription").
    #[serde(default)]
    auth: Option<String>,
}

/// fx, one row per provider, and the three are a closed set.
///
/// Unlike pi's, fx's providers *are* nameable — `fx login [vercel|codex|grok]`
/// is the whole list — so all three are drawn whether connected or not, which
/// is what makes signing into a new one reachable from the rows themselves.
async fn fx() -> anyhow::Result<Vec<Account>> {
    let stdout = run(Harness::Fx, &["status", "--json"]).await?.out;
    let status: FxStatus = serde_json::from_str(&stdout)
        .map_err(|err| anyhow::anyhow!("couldn't read what fx said about its providers: {err}"))?;

    Ok(FX_PROVIDERS
        .iter()
        .map(|(arg, wire, label)| {
            let connected = status.connected_providers.iter().any(|p| p == wire);

            Account {
                provider: Some(arg.to_string()),
                label: label.to_string(),
                state: if connected {
                    AccountState::LoggedIn
                } else {
                    AccountState::LoggedOut
                },
                // fx names one provider as the active one and says nothing
                // about the rest, so the sentence goes on the row it is about.
                detail: (connected && names(status.auth.as_deref(), label))
                    .then(|| status.auth.clone())
                    .flatten(),
                auth_type: None,
                can_sign_out: connected,
                can_change_method: auth_options(Harness::Fx, Some(arg)).len() > 1,
            }
        })
        .collect())
}

/// Whether fx's `auth` sentence is about this provider.
///
/// Matched loosely on purpose: the field is prose ("Grok subscription", "Vercel
/// AI Gateway") and a miss costs one detail line where a wrong hit would put
/// another provider's plan under this one's name.
fn names(auth: Option<&str>, label: &str) -> bool {
    auth.is_some_and(|auth| auth.to_lowercase().contains(&label.to_lowercase()))
}

// ---------------------------------------------------------------- pi's store

/// Where pi keeps its credentials.
fn pi_auth_path() -> Option<PathBuf> {
    Some(std::env::home_dir()?.join(".pi/agent/auth.json"))
}

/// Serializes Dray's own read-modify-write of pi's credential file.
///
/// The file is rewritten **whole**, so two of these interleaving loses whichever
/// read first — and the pair that can do it is ordinary: saving a key while a
/// sign-out is in flight. It cannot lock against *pi*, which is a second writer
/// with no lock to take; what it removes is this process racing itself.
static PI_STORE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// pi's credential file, or an empty map.
///
/// **For reading only.** A missing, unreadable or malformed file all read as no
/// credentials here, which is right for a caller listing what is there: the
/// worst case is a row saying a provider is not configured when it is, and the
/// probe next door answers the same question independently.
///
/// A *writer* must take [`pi_auth_strict`] instead, or an unreadable file would
/// be replaced by a map holding one entry.
fn pi_auth() -> Map<String, Value> {
    pi_auth_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<Map<String, Value>>(&raw).ok())
        .unwrap_or_default()
}

/// pi's credential file for a caller about to rewrite it.
///
/// **A file that cannot be read or cannot be parsed is an error, never an empty
/// map**, and the difference is every other credential in it: the file is
/// rewritten whole, so treating a transient read failure or a malformed byte as
/// "no credentials" writes a file holding one entry and silently drops every
/// OAuth record `/login` put there. Only *absent* is empty, which is the
/// ordinary state of a machine that has never signed pi in.
///
/// Malformed is refused rather than recovered from — the opposite of
/// `settings::update`, and for the opposite reason: bytes that cannot be parsed
/// cannot be preserved, and what would be lost here is credentials rather than
/// preferences.
fn pi_auth_strict() -> Result<Map<String, Value>, String> {
    let path = pi_auth_path().ok_or("no home directory")?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(err) => return Err(format!("couldn't read pi's credentials: {err}")),
    };
    if raw.trim().is_empty() {
        return Ok(Map::new());
    }
    serde_json::from_str(&raw).map_err(|err| {
        format!("pi's credential file isn't readable JSON ({err}), so Dray won't overwrite it.")
    })
}

/// Reads pi's store, lets `edit` change it, and puts it back — or changes
/// nothing at all.
///
/// One function because both writers need the same four guarantees: the lock
/// above, a strict read, `0600` on the *create*, and a rename rather than a
/// truncating write. `edit` answers `Err` to call the whole thing off, which is
/// what a sign-out for a provider pi does not hold does.
fn pi_edit_store(edit: impl FnOnce(&mut Map<String, Value>) -> Result<(), String>) -> Result<(), String> {
    let path = pi_auth_path().ok_or("no home directory")?;
    let dir = path.parent().ok_or("no pi directory")?.to_path_buf();

    // Held across the read, the edit and the rename — the whole point of it —
    // and nothing in here awaits, so it cannot be held across a suspend.
    let _guard = PI_STORE.lock().unwrap_or_else(|err| err.into_inner());

    let mut auth = pi_auth_strict()?;
    edit(&mut auth)?;
    let body = serde_json::to_string_pretty(&auth).map_err(|err| err.to_string())?;

    std::fs::create_dir_all(&dir).map_err(|err| format!("couldn't reach pi's directory: {err}"))?;
    let tmp = dir.join(format!("auth.json.dray-{}", uuid::Uuid::now_v7()));
    write_private(&tmp, &body).map_err(|err| format!("couldn't write pi's credentials: {err}"))?;
    if let Err(err) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("couldn't replace pi's credentials: {err}"));
    }

    // The model list is per provider, so a credential moving is a new list.
    crate::harness::pi::models::forget();
    Ok(())
}

/// Which providers pi holds a credential for, **names only**.
///
/// The tokens beside them are never read. This exists because a key written a
/// moment ago is a credential pi has before it is a model list pi serves.
fn pi_store_providers() -> Vec<String> {
    pi_auth().keys().cloned().collect()
}

/// Writes one provider's API key into pi's own store, leaving the rest alone.
///
/// **Shape read out of pi's bundle, not out of a document pi published**:
/// a credential is `{"type": "api_key", "key": "…"}` under the provider's id,
/// beside the `{"type": "oauth", …}` entries `/login` writes. So it is checked
/// by `pi auth check` afterwards rather than trusted — if pi moves the shape,
/// the row says the credential is not configured instead of claiming a save
/// that did nothing.
///
/// Every other credential in the file is left exactly as it was — see
/// [`pi_edit_store`], which is where that promise is actually kept.
fn pi_write_key(provider: &str, key: &str) -> Result<(), String> {
    pi_edit_store(|auth| {
        auth.insert(
            provider.to_string(),
            serde_json::json!({ "type": "api_key", "key": key }),
        );
        Ok(())
    })
}

/// Removes one provider from pi's store.
fn pi_forget_provider(provider: &str) -> Result<(), String> {
    pi_edit_store(|auth| {
        auth.remove(provider)
            .map(|_| ())
            .ok_or_else(|| format!("pi holds no credential for {provider}."))
    })
}

/// Creates at `0600` and writes, never a `chmod` after.
///
/// `create_new` because a leftover from a crashed write could be somebody
/// else's, at whatever mode they chose.
fn write_private(path: &std::path::Path, body: &str) -> std::io::Result<()> {
    use std::io::Write;

    let mut file = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)?
        }
        #[cfg(not(unix))]
        {
            std::fs::OpenOptions::new().write(true).create_new(true).open(path)?
        }
    };
    file.write_all(body.as_bytes())
}

// -------------------------------------------------------------------- writes

/// Whether this harness's login command takes `provider` as an argument.
///
/// The one place a provider name is judged for the *terminal* path, shared with
/// [`crate::apps::open_login_terminal`] — which composes a shell script, so the
/// answer being a closed set rather than an escaping rule is what makes it
/// safe. pi's providers are deliberately **not** here: its login is a slash
/// command inside a TUI, so there is no word to append.
pub fn login_provider(harness: Harness, provider: &str) -> bool {
    harness == Harness::Fx && FX_PROVIDERS.iter().any(|(arg, _, _)| *arg == provider)
}

/// Whether a name is one this build will hand to a CLI.
///
/// Belt and braces beside the closed-set checks: everything below reaches a
/// process argument or a shell script, and a provider typed by the reader —
/// which pi's is — has to be judged on shape before pi is asked about it.
fn plausible_provider(provider: &str) -> bool {
    !provider.is_empty()
        && provider.len() <= 64
        && provider
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Saves a pasted key into the CLI's own store.
///
/// **Only the key routes reach Rust at all.** Every other option is a command
/// the reader runs themselves — see [`AuthOption::command`] — so there is no
/// terminal path here and no shell string composed anywhere for this flow.
///
/// Every argument is judged against what [`auth_options`] offered rather than
/// taken as given: `auth` must be an id that list holds *for this provider*,
/// which is what stops a key field being honoured on `openai-codex`, whose only
/// way in is OAuth.
pub async fn add_account(
    harness: Harness,
    provider: Option<String>,
    auth: String,
    key: Option<String>,
) -> Result<(), String> {
    let provider = provider.filter(|p| !p.is_empty());
    if let Some(provider) = provider.as_deref() {
        if !plausible_provider(provider) {
            return Err(format!("{provider} is not a provider name."));
        }
    }

    let option = auth_options(harness, provider.as_deref())
        .into_iter()
        .find(|option| option.id == auth)
        .ok_or_else(|| format!("{} has no such way of signing in.", harness.label()))?;

    if !option.needs_key {
        return Err("That one is run in a terminal.".to_string());
    }

    // Refused before anything is spawned or written: an empty key handed to
    // `codex login --with-api-key` comes back as its usage text, which reads as
    // Dray malfunctioning rather than as an empty field.
    let key = key.unwrap_or_default().trim().to_string();
    if key.is_empty() {
        return Err("Paste a key first.".to_string());
    }

    match harness {
        Harness::Codex => codex_set_key(&key).await,
        Harness::Pi => {
            let provider = provider.ok_or("Pick a provider first.")?;
            // Asked of pi rather than of the shortlist, which is why a provider
            // added after this build still works and a typo is still refused.
            match pi_check(&provider).await {
                Some(check) if check.status == "not_ready" && check.reason.as_deref() == Some("provider_not_found") => {
                    return Err(format!("pi doesn't know a provider called {provider}."))
                }
                // A probe that could not run is not proof of a bad name, and
                // refusing here would block a save over a failure that has
                // nothing to do with what was typed.
                _ => {}
            }
            pi_write_key(&provider, &key)
        }
        _ => Err(format!("{} cannot take a key here.", harness.label())),
    }
}

/// Hands a key to Codex's own store.
///
/// `codex login --with-api-key` reads it off **stdin**, so nothing is written
/// by Dray and nothing is kept. It also **flips `auth_mode`**, which is why the
/// option carrying it says out loud that it replaces the ChatGPT sign-in — the
/// switch is the CLI's, but the sentence has to be ours, since `codex` says
/// nothing before doing it.
async fn codex_set_key(key: &str) -> Result<(), String> {
    let bin = binpath::agent_binary(Harness::Codex).await;
    let mut child = Command::new(&bin)
        .args(["login", "--with-api-key"])
        .env("PATH", agent_path(&bin))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Bounded below, and this is what makes the bound real: a timeout drops
        // the future, and without it the child lives on holding the key it was
        // handed.
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| format!("couldn't run codex: {err}"))?;

    {
        let mut stdin = child.stdin.take().ok_or("couldn't reach codex's stdin")?;
        stdin
            .write_all(key.as_bytes())
            .await
            .map_err(|err| format!("couldn't hand codex the key: {err}"))?;
        // Dropped here, closing the pipe: `--with-api-key` reads to EOF, so a
        // stdin left open holds the child forever.
    }

    let output = tokio::time::timeout(PROBE_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "codex took too long to take the key.".to_string())?
        .map_err(|err| format!("codex didn't finish: {err}"))?;

    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "Codex refused the key.".to_string()
    } else {
        stderr
    })
}

/// Signs one credential out, where the CLI can do it without a terminal.
///
/// Three of the four can: `claude auth logout` and `codex logout` drop the one
/// credential each holds, `fx logout <provider>` drops one of three. pi has no
/// such subcommand, so its half is removing the record from the store this
/// module writes the other half of — which is why it is offered on a pi row
/// only where that store actually holds the provider.
pub async fn sign_out(harness: Harness, provider: Option<String>) -> Result<(), String> {
    let provider = provider.filter(|p| !p.is_empty());

    let args: Vec<&str> = match harness {
        Harness::ClaudeCode => vec!["auth", "logout"],
        Harness::Codex => vec!["logout"],
        Harness::Fx => {
            let provider = provider.as_deref().ok_or("Which provider?")?;
            if !login_provider(harness, provider) {
                return Err(format!("{provider} is not an fx provider."));
            }
            vec!["logout", provider]
        }
        Harness::Pi => {
            let provider = provider.as_deref().ok_or("Which provider?")?;
            if !plausible_provider(provider) {
                return Err(format!("{provider} is not a provider name."));
            }
            return pi_forget_provider(provider);
        }
        Harness::Other(_) => return Err("Dray cannot drive that agent.".to_string()),
    };

    let bin = binpath::agent_binary(harness).await;
    // Bounded like the probes, and `kill_on_drop` is what makes the bound real:
    // a CLI that decides to prompt instead of answering would otherwise hold
    // the page busy for the life of the app, with Refresh and every row's menu
    // disabled behind it.
    let output = tokio::time::timeout(
        PROBE_TIMEOUT,
        Command::new(&bin)
            .args(&args)
            .env("PATH", agent_path(&bin))
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| format!("{} took too long to sign out.", harness.label()))?
    .map_err(|err| format!("couldn't run {}: {err}", harness.label()))?;

    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("{} refused the sign-out.", harness.label())
    } else {
        stderr
    })
}

// ------------------------------------------------------------------ commands

/// Every harness's login state, for the Accounts tab.
///
/// A command rather than something the tab computes, since each answer is a
/// child process. Uncached and re-asked on every open: the reader arrives here
/// *because* they are about to change a login, so a cached answer would be
/// stale exactly when it is being read.
#[tauri::command]
pub async fn agent_accounts() -> Vec<AgentAccounts> {
    all().await
}

/// The ways into one harness, for the Add-account flow's second step.
#[tauri::command]
pub fn agent_auth_options(harness: Harness, provider: Option<String>) -> Vec<AuthOption> {
    auth_options(harness, provider.as_deref())
}

/// Saves a pasted key — see [`add_account`].
#[tauri::command]
pub async fn add_agent_account(
    harness: Harness,
    provider: Option<String>,
    auth: String,
    key: Option<String>,
) -> Result<(), String> {
    add_account(harness, provider, auth, key).await
}

/// Signs one credential out — see [`sign_out`].
#[tauri::command]
pub async fn sign_out_agent(harness: Harness, provider: Option<String>) -> Result<(), String> {
    sign_out(harness, provider).await
}

/// Runs an interactive sign-in in a terminal.
///
/// **No shell string crosses the bridge.** The caller names the same closed set
/// `add_agent_account` takes — harness, provider, option id — and the command
/// is looked up here in [`auth_options`], where every one of them is a literal.
/// A frontend can therefore ask for a flow this build offered and nothing else,
/// which is the rule `permissions.rs` states and the reason this is not simply
/// handed the string the row is already showing.
///
/// Terminal.app rather than the terminal picked next door: handed a `.command`
/// file, it is the only one measured to run it. That pick still stands for
/// *opening a directory*, which is all the table behind it promises.
#[tauri::command]
pub async fn run_agent_login(
    harness: Harness,
    provider: Option<String>,
    auth: String,
    cwd: String,
) -> Result<(), String> {
    let provider = provider.filter(|p| !p.is_empty());
    if let Some(provider) = provider.as_deref() {
        if !plausible_provider(provider) {
            return Err(format!("{provider} is not a provider name."));
        }
    }

    let command = auth_options(harness, provider.as_deref())
        .into_iter()
        .find(|option| option.id == auth)
        .and_then(|option| option.command)
        .ok_or_else(|| format!("{} has no such sign-in.", harness.label()))?;

    crate::apps::run_in_terminal(&command, &cwd).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two spellings of an fx provider are both real and neither derives
    /// from the other: the short one is what `fx login` takes, the long one is
    /// what `fx status --json` reports. A row whose pair drifted reads as
    /// permanently signed out while the button signs the right one in.
    #[test]
    fn every_fx_provider_has_both_spellings_and_a_label() {
        for (arg, wire, label) in FX_PROVIDERS {
            assert!(!arg.is_empty());
            assert!(!wire.is_empty());
            assert!(!label.is_empty());
        }
    }

    /// The captured `fx status --json` from a machine with all three connected.
    #[test]
    fn fx_reads_its_connected_providers_and_puts_the_sentence_on_one_row() {
        let status: FxStatus = serde_json::from_str(
            r#"{"model":"grok-4.6","auth":"Grok subscription",
                "connected_providers":["vercel-ai-gateway","codex","grok"]}"#,
        )
        .unwrap();

        assert_eq!(status.connected_providers.len(), 3);
        assert!(names(status.auth.as_deref(), "Grok"));
        // The sentence is about Grok, so it must not be drawn under the other
        // two — which is the whole of why the row asks rather than the harness.
        assert!(!names(status.auth.as_deref(), "Codex"));
        assert!(!names(status.auth.as_deref(), "Vercel AI Gateway"));
    }

    /// An fx that stops reporting a field must cost the detail, never the rows.
    #[test]
    fn fx_says_nothing_rather_than_failing_when_a_field_goes() {
        let status: FxStatus = serde_json::from_str(r#"{"model":"grok-4.6"}"#).unwrap();

        assert!(status.connected_providers.is_empty());
        assert!(!names(status.auth.as_deref(), "Grok"));
    }

    /// The captured `claude auth status --json`, every field present.
    #[test]
    fn claude_names_the_account_before_the_plan() {
        let status: ClaudeStatus = serde_json::from_str(
            r#"{"loggedIn":true,"authMethod":"claude.ai","email":"reader@example.com",
                "orgName":"Reader","subscriptionType":"max"}"#,
        )
        .unwrap();

        assert!(status.logged_in);
        assert_eq!(status.email.as_deref(), Some("reader@example.com"));
        assert_eq!(status.auth_method.as_deref(), Some("claude.ai"));
    }

    /// A `loggedIn: false` answer carrying nothing else still parses, or a
    /// signed-out Claude would read as a broken probe.
    #[test]
    fn claude_logged_out_carries_no_identity() {
        let status: ClaudeStatus = serde_json::from_str(r#"{"loggedIn":false}"#).unwrap();

        assert!(!status.logged_in);
        assert!(status.email.is_none());
    }

    /// Codex's own two captures, and the exit code on its own is not enough.
    ///
    /// The words are what make this safe against a future non-zero exit for
    /// some unrelated reason, and the code is what makes it safe against Codex
    /// rewording the sentence. Neither alone survived both captures — and the
    /// last case is the one that matters most: a failure Codex does not explain
    /// must not be reported as a login that is missing.
    #[test]
    fn codex_is_read_from_its_words_and_its_exit_code_together() {
        assert_eq!(codex_state(true, "Logged in using ChatGPT"), AccountState::LoggedIn);
        assert_eq!(codex_state(false, "Not logged in"), AccountState::LoggedOut);
        // Reworded and still signed in: the code carries it.
        assert_eq!(codex_state(true, "Authenticated as somebody"), AccountState::LoggedIn);
        // Exited clean and said otherwise: the words carry it.
        assert_eq!(
            codex_state(true, "Not logged in. Run `codex login`."),
            AccountState::LoggedOut
        );
        // Broke for some other reason and said nothing about a login: unknown,
        // never signed out.
        assert_eq!(
            codex_state(false, "error: config.toml is not valid"),
            AccountState::Unknown
        );
    }

    /// pi answers in snake case, which is a log line rather than a sentence
    /// about somebody's account.
    #[test]
    fn a_pi_reason_is_read_as_prose() {
        assert_eq!(
            humanize("credentials_not_configured".into()),
            "Credentials not configured"
        );
        assert_eq!(humanize(String::new()), "");
    }

    /// The seed names what it can and never decides what exists — a provider pi
    /// serves that nobody listed draws its own id rather than vanishing.
    #[test]
    fn an_unlisted_pi_provider_is_still_named() {
        assert_eq!(pi_label("anthropic"), "Anthropic");
        assert_eq!(pi_label("something-new"), "something-new");
    }

    /// **pi's methods are per provider**, which the first draft got wrong: it
    /// offered OAuth and a key on every row, where six of pi's providers have
    /// OAuth and `openai-codex` has no key at all. Both halves of that mistake
    /// are a control the reader can pick that ends in a refusal.
    #[test]
    fn pi_offers_a_provider_only_what_it_has() {
        let ids = |provider| -> Vec<String> {
            auth_options(Harness::Pi, Some(provider))
                .into_iter()
                .map(|option| option.id)
                .collect()
        };

        // Both, and it is one of the six.
        assert_eq!(ids("anthropic"), vec!["oauth", "api_key"]);
        // A subscription nobody holds a key for.
        assert_eq!(ids("openai-codex"), vec!["oauth"]);
        // The ordinary case: a key and nothing else.
        assert_eq!(ids("deepseek"), vec!["api_key"]);
        assert_eq!(ids("groq"), vec!["api_key"]);
        // Typed by the reader and unknown to this build, so both are offered
        // and pi is what refuses — the same reading the seed list takes.
        assert_eq!(ids("some-new-provider"), vec!["oauth", "api_key"]);
    }

    /// A provider whose credential is structured rather than a key or a
    /// sign-in is not offered at all: there is no method this tab could draw
    /// for it, and a row that can be picked and then offers nothing is a dead
    /// end two clicks deep. It keeps its name, since a row for one can still
    /// appear from pi's own model list.
    #[test]
    fn a_structured_credential_is_not_offered_but_is_still_named() {
        let offered = providers_of(Harness::Pi);

        for id in ["amazon-bedrock", "google-vertex", "cloudflare-workers-ai"] {
            assert!(
                !offered.iter().any(|choice| choice.id == id),
                "{id} was offered with no way to sign into it"
            );
            assert_ne!(pi_label(id), id, "{id} lost its name");
        }
        assert!(offered.iter().any(|choice| choice.id == "anthropic"));
    }

    /// **A provider with one way in has nothing to change**, which is what the
    /// ⋯ menu words itself from. fx's Codex and Grok are a subscription each
    /// and offered "change sign-in method" for a form that could only ever
    /// show them the one command; they say Reauthorize now. Vercel keeps the
    /// change, having a gateway key beside the sign-in.
    #[test]
    fn only_a_provider_with_two_ways_in_can_change_method() {
        let changeable = |harness, provider| auth_options(harness, provider).len() > 1;

        assert!(!changeable(Harness::Fx, Some("codex")));
        assert!(!changeable(Harness::Fx, Some("grok")));
        assert!(changeable(Harness::Fx, Some("vercel")));

        // Both hold one credential and two ways of holding it, which bill
        // differently — the case the control exists for.
        assert!(changeable(Harness::ClaudeCode, None));
        assert!(changeable(Harness::Codex, None));

        // pi is per provider, the same split its methods are.
        assert!(changeable(Harness::Pi, Some("anthropic")));
        assert!(!changeable(Harness::Pi, Some("openai-codex")));
        assert!(!changeable(Harness::Pi, Some("deepseek")));
    }

    /// Every option that is not a key field carries the command the reader is
    /// meant to run. Dray runs none of them — macOS lets no app type into
    /// another's prompt — so an option with neither a field nor a command is a
    /// step that asks for something and says nothing.
    #[test]
    fn every_option_is_a_field_or_a_command() {
        for harness in Harness::ALL {
            let providers = providers_of(harness);
            let cases: Vec<Option<&str>> = if providers.is_empty() {
                vec![None]
            } else {
                providers.iter().map(|p| Some(p.id.as_str())).collect()
            };

            for provider in cases {
                for option in auth_options(harness, provider) {
                    assert_eq!(
                        option.needs_key,
                        option.command.is_none(),
                        "{} / {provider:?} / {} is neither",
                        harness.label(),
                        option.id
                    );
                    if let Some(command) = &option.command {
                        assert!(!command.is_empty());
                    }
                }
            }
        }
    }

    /// Everything below reaches a process argument or a shell script, and pi's
    /// provider is the one the reader may type.
    #[test]
    fn a_typed_provider_is_judged_on_shape() {
        assert!(plausible_provider("anthropic"));
        assert!(plausible_provider("amazon-bedrock"));
        assert!(!plausible_provider(""));
        assert!(!plausible_provider("a b"));
        assert!(!plausible_provider("rm -rf /"));
        assert!(!plausible_provider("a;b"));
        assert!(!plausible_provider("$(whoami)"));
        assert!(!plausible_provider(&"x".repeat(65)));
    }

    /// Every harness that can be driven offers at least one way in, and every
    /// option it offers is one `add_account` will accept — the list *is* the
    /// closed set, so an option nobody can take is a dead control.
    #[test]
    fn every_offered_option_is_one_that_can_be_taken() {
        for harness in Harness::ALL {
            let providers = providers_of(harness);
            let cases: Vec<Option<&str>> = if providers.is_empty() {
                vec![None]
            } else {
                providers.iter().map(|p| Some(p.id.as_str())).collect()
            };

            for provider in cases {
                let options = auth_options(harness, provider);
                assert!(
                    !options.is_empty(),
                    "{} offers no way in",
                    harness.label()
                );
                for option in &options {
                    assert!(!option.id.is_empty() && !option.label.is_empty());
                }
                // A key-taking option must be one of the two that can take one,
                // or the field is drawn over a route that ends in a refusal.
                for option in options.iter().filter(|o| o.needs_key) {
                    assert!(
                        matches!(harness, Harness::Codex | Harness::Pi),
                        "{} offers a key field it cannot honour",
                        harness.label()
                    );
                }
            }
        }
    }

    /// Only the two harnesses with a key path take one, and an empty key never
    /// reaches either.
    #[tokio::test]
    async fn a_key_is_refused_where_it_cannot_land() {
        // Claude has no key form at all, so no option of its own carries one —
        // which is what makes this a refusal rather than a spawn.
        assert!(add_account(
            Harness::ClaudeCode,
            None,
            "api_key".into(),
            Some("sk-test".into())
        )
        .await
        .is_err());

        // A real option, no key behind it.
        assert!(add_account(Harness::Codex, None, "api_key".into(), None)
            .await
            .is_err());
        assert!(add_account(
            Harness::Codex,
            None,
            "api_key".into(),
            Some("   ".into())
        )
        .await
        .is_err());

        // An option nobody offered.
        assert!(add_account(Harness::Fx, Some("grok".into()), "api_key".into(), Some("k".into()))
            .await
            .is_err());
    }

    /// A provider that reaches a command line is judged first, whatever it was
    /// asked to do.
    #[tokio::test]
    async fn a_bad_provider_never_reaches_a_cli() {
        assert!(add_account(
            Harness::Pi,
            Some("../../etc".into()),
            "api_key".into(),
            Some("k".into())
        )
        .await
        .is_err());
        assert!(sign_out(Harness::Fx, Some("anthropic".into())).await.is_err());
        assert!(sign_out(Harness::Pi, Some("a b".into())).await.is_err());
        // fx signs out one of three, so it must be told which.
        assert!(sign_out(Harness::Fx, None).await.is_err());
    }

    /// What the CLIs on *this* machine actually answer.
    ///
    /// `#[ignore]` for the reason `pi/models.rs`'s own live test is: it spawns
    /// four real binaries and its result depends on who is signed in, so it is
    /// run by hand — `cargo test what_the_installed_agents_answer -- --ignored
    /// --nocapture` — when one of these CLIs changes what it says. Every parser
    /// above was written against a capture from this, and it is how the next
    /// wire-format move gets caught.
    #[tokio::test]
    #[ignore]
    async fn what_the_installed_agents_answer() {
        for agent in all().await {
            println!(
                "{} installed={} providers={} error={:?}",
                agent.label,
                agent.installed,
                agent.providers.len(),
                agent.error
            );
            for account in &agent.accounts {
                println!(
                    "    {:?} {} [{}] auth={:?} out={} {:?}",
                    account.state,
                    account.label,
                    account.provider.as_deref().unwrap_or("-"),
                    account.auth_type,
                    account.can_sign_out,
                    account.detail
                );
            }
            // An installed CLI answering with neither rows nor a reason is the
            // one shape the tab can draw nothing honest for.
            assert!(
                !agent.installed || !agent.accounts.is_empty() || agent.error.is_some(),
                "{} answered nothing at all",
                agent.label
            );
        }
    }
}
