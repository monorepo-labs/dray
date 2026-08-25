#!/bin/sh
# Installs the `dray` CLI and its Claude Code skill.
#
# Deliberately POSIX sh, not bash: this is piped into whatever /bin/sh is, and
# on a minimal linux image that is dash rather than bash.
#
#   curl -fsSL https://drayhq.com/install.sh | sh
#
# Honours:
#   DRAY_INSTALL_DIR   where the binary lands (default ~/.local/bin)
#   DRAY_VERSION       a specific release tag (default: latest)

set -eu

REPO="yogesharc/dray"
INSTALL_DIR="${DRAY_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${DRAY_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

# Rust's target triples, which is what the release artifacts are named after.
detect_target() {
  os=$(uname -s)
  arch=$(uname -m)

  case "$os" in
    Darwin) os_part="apple-darwin" ;;
    Linux)  os_part="unknown-linux-gnu" ;;
    *) die "unsupported OS: $os. dray builds for macOS and Linux." ;;
  esac

  case "$arch" in
    # `arm64` is what macOS reports, `aarch64` what Linux does. Same target.
    arm64|aarch64) arch_part="aarch64" ;;
    x86_64|amd64)  arch_part="x86_64" ;;
    *) die "unsupported architecture: $arch" ;;
  esac

  printf '%s-%s' "$arch_part" "$os_part"
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed."
}

need uname
need tar
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "curl or wget is required."
fi

TARGET=$(detect_target)

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/dray-$TARGET.tar.gz"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/dray-$TARGET.tar.gz"
fi

TMP=$(mktemp -d)
# Runs on failure too, so a half-finished install leaves nothing behind.
trap 'rm -rf "$TMP"' EXIT INT TERM

say "Downloading dray ($TARGET)…"
fetch "$URL" "$TMP/dray.tar.gz" || die "could not download $URL"

tar -xzf "$TMP/dray.tar.gz" -C "$TMP" || die "could not unpack the download"
[ -f "$TMP/dray" ] || die "the archive did not contain a dray binary"

mkdir -p "$INSTALL_DIR"
chmod +x "$TMP/dray"
# `mv` within one filesystem is atomic, so an upgrade never leaves a truncated
# binary where a working one was. Falls back to cp across filesystems.
mv "$TMP/dray" "$INSTALL_DIR/dray" 2>/dev/null || {
  cp "$TMP/dray" "$INSTALL_DIR/dray"
  chmod +x "$INSTALL_DIR/dray"
}

say "Installed $INSTALL_DIR/dray"

# From the binary itself rather than downloaded separately, so the skill can
# never describe a version of the CLI other than the one just installed.
if "$INSTALL_DIR/dray" skill install; then
  :
else
  say "Note: the skill could not be installed. Run 'dray skill install' by hand."
fi

# `case` rather than grep, so a directory whose name contains another's does not
# read as already present.
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say ""
    say "$INSTALL_DIR is not on your PATH. Add this to your shell profile:"
    say ""
    say "    export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

say ""
say "Done. Run 'dray --help' to get started, with the Dray app running."
