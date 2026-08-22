/// A commit carries an email and nothing else — git has no account behind it —
/// so a face has to be resolved from that address alone.
///
/// Two routes, in order of certainty. GitHub's noreply address *contains* the
/// account id, so it resolves exactly; guessing a login from a name would not,
/// and `github.com/<login>.png` 404s for precisely the bot accounts that show
/// up most in a history. Everything else goes to Gravatar, which is what git
/// clients have always used and what most people's commits already resolve
/// through.
///
/// Both can miss, and missing is fine: the request 404s and [Avatar] keeps the
/// initial it was already drawing.
const SIZE = 48;

/// `12345+login@users.noreply.github.com`, the address GitHub hands out and
/// commits made through its own UI carry. The leading number is the account id.
const GITHUB_NOREPLY = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i;

export function githubAvatar(email: string): string | null {
  const match = GITHUB_NOREPLY.exec(email.trim());
  return match ? `https://avatars.githubusercontent.com/u/${match[1]}?s=${SIZE}` : null;
}

/// Gravatar takes a SHA-256 of the lowercased, trimmed address — which is why
/// this can be done here at all: the digest is `crypto.subtle`'s, so no hashing
/// dependency comes with it.
///
/// `d=404` rather than a generated fallback: a missing account should fail the
/// request so the initial stays, instead of covering it with a stranger's
/// pattern that reads as a real person.
export async function gravatarUrl(email: string): Promise<string | null> {
  const address = email.trim().toLowerCase();
  if (!address) return null;

  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
    const hash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `https://gravatar.com/avatar/${hash}?s=${SIZE}&d=404`;
  } catch {
    // `crypto.subtle` needs a secure context. Losing the picture is not worth
    // reporting anywhere — the letter is already on screen.
    return null;
  }
}
