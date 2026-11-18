/// True in the build `pnpm build:web` makes, which `dray-serve` hands out at
/// `/web/`. Fixed at build time: the page cannot ask Tauri whether it is
/// inside the app without a call that fails outside it.
export const IS_WEB_APP = import.meta.env.MODE === "web";

const TOKEN_KEY = "dray.webToken";
const REFUSED_KEY = "dray.webTokenRefused";

let read: string | null | undefined;

/// The serve token this browser was given. A `?token=` in the address is kept
/// for later loads and dropped from the bar, so it stays out of history and
/// out of a screenshot of the URL. Read once, so every caller sees one answer.
export function webToken(): string | null {
  if (read === undefined) read = readToken();
  return read;
}

function readToken(): string | null {
  const query = new URLSearchParams(location.search);
  const given = query.get("token");
  if (given) {
    remember(given);
    query.delete("token");
    const rest = query.toString();
    history.replaceState(null, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
    return given;
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/// Keeps `token` and reloads, since the transport reads it once at load.
export function saveWebToken(token: string) {
  remember(token);
  location.reload();
}

/// Drops a token the server refused and reloads onto the token form, which
/// then says why it is back.
export function refuseWebToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.setItem(REFUSED_KEY, "1");
  } catch {
    // Storage blocked: the form shows without the reason.
  }
  location.reload();
}

/// Whether the last token was refused. Read once by the form.
export function tokenWasRefused(): boolean {
  try {
    const refused = sessionStorage.getItem(REFUSED_KEY) === "1";
    sessionStorage.removeItem(REFUSED_KEY);
    return refused;
  } catch {
    return false;
  }
}

/// The socket of the server that served this page.
export function webServerUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

function remember(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage blocked: this load still has the token, the next asks again.
  }
}
