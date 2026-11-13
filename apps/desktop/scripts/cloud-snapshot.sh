#!/usr/bin/env bash
# Builds the `dray-cloud` saved snapshot every Dray Cloud machine is created
# from (#857): a boat sandbox with `dray` and `dray-serve` installed, agents
# installed but signed in nowhere, and the server enabled as a systemd user
# service that starts on its own after create and resume. Every stable release
# runs it (#1011, .github/workflows/cloud-snapshot.yml).
#
# Nothing moves `dray-cloud` until a machine made from the build has proved it
# works. The build is saved as `dray-cloud-candidate`, a machine is created
# from that the way the control plane creates one, and only once the app's own
# handshake passes on it (cloud-verify.mjs) is `dray-cloud` saved from the same
# disk. A failure anywhere leaves `dray-cloud` as it was.
#
# Run it on a machine where `boat login` is done, with Node 22 or newer:
#
#   BOAT_ORG=<org> apps/desktop/scripts/cloud-snapshot.sh
#
# Honours:
#   BOAT_ORG          the org the snapshot is saved in; the control plane's key
#                     must be in the same one (default: the active org)
#   DRAY_VERSION      a cli-v* release to install (default: the newest)
#   DRAY_REF          a git ref to build dray and dray-serve from instead, on
#                     the sandbox. A source build never updates itself.
#   DRAY_CLOUD_TOOLS  what `dray setup` installs (default below)
#   SNAPSHOT          the name to save under (default dray-cloud). Another
#                     name tries the whole run without touching real machines.
#   VERSION_URL       where a machine reads, before every start, the release
#                     it should run (default below; the release workflow writes it)
#   BOAT_TYPE         the build sandbox's size (default: boat's default)
#   KEEP=1            leave the build and verify sandboxes afterwards
#
# Each step follows docs.boat.dev: `boat new --json` prints JSON Lines ending
# in a `ready` event; `boat ssh ID -- bash -s` runs a script with no tty;
# `boat snapshot ID NAME` saves the disk and polls until the save is ready;
# saving the same name again replaces it, and machines already made keep
# theirs. A save from a stopped sandbox uses its last snapshot, so two saves
# from one stopped sandbox are the same disk.

set -euo pipefail

NAME="${SNAPSHOT:-dray-cloud}"
CANDIDATE="$NAME-candidate"
TOOLS="${DRAY_CLOUD_TOOLS:-git,gh,claude_code,codex,browser,ffmpeg}"
VERSION_URL="${VERSION_URL:-https://downloads.drayhq.com/cloud/serve-version}"
# The port the control plane hosts: PORT in apps/web/src/lib/cloud/cloud.ts.
PORT=7317
here=$(cd "$(dirname "$0")" && pwd)

die() { printf 'cloud-snapshot: %s\n' "$*" >&2; exit 1; }
say() { printf '\033[36m●\033[0m  %s\n' "$*"; }

command -v boat >/dev/null || die "the boat CLI is not installed"
command -v jq >/dev/null || die "jq is not installed"
command -v node >/dev/null || die "node is not installed"
protocol=$(sed -n 's/^pub const PROTOCOL: u32 = \([0-9]*\);/\1/p' "$here/../src-tauri/src/serve.rs")
[ -n "$protocol" ] || die "could not read the serve protocol out of serve.rs"

b() { boat ${BOAT_ORG:+--org "$BOAT_ORG"} "$@"; }

say "Creating the build sandbox"
# No env, as every Dray Cloud create is: nothing of the account's lands on the
# disk the snapshot keeps.
id=$(b new --json --no-env --ttl 7200 --name "dray-cloud build" ${BOAT_TYPE:+--type "$BOAT_TYPE"} \
  | jq -r 'select(.event == "ready") | .id' | tail -n1)
[ -n "$id" ] && [ "$id" != null ] || die "boat new reported no ready sandbox"
say "Build sandbox $id"

verify_id=
cleanup() {
  if [ "${KEEP:-}" = 1 ]; then
    say "Kept $id${verify_id:+ and $verify_id}. Delete each with: boat delete <id> --yes"
  else
    for sandbox in $id $verify_id; do
      b delete "$sandbox" --yes >/dev/null || printf 'could not delete %s; delete it by hand\n' "$sandbox" >&2
    done
  fi
  # The candidate alone: `$NAME` is either untouched or already the verified disk.
  b snapshot rm "$CANDIDATE" >/dev/null 2>&1 || :
}
trap cleanup EXIT

b ssh "$id" -- env \
  DRAY_VERSION="${DRAY_VERSION:-}" DRAY_REF="${DRAY_REF:-}" TOOLS="$TOOLS" VERSION_URL="$VERSION_URL" \
  bash -s <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
step() { printf '\033[36m●\033[0m  [sandbox] %s\n' "$*"; }

# The release install first even when building from source: it also puts the
# skill in place and `~/.local/bin` on PATH. No setup questions here.
step "Installing dray ${DRAY_VERSION:-(newest release)}"
curl -fsSL https://www.drayhq.com/install.sh | DRAY_UPDATING=1 DRAY_VERSION="$DRAY_VERSION" sh

if [ -n "$DRAY_REF" ]; then
  step "Building dray and dray-serve at $DRAY_REF"
  sudo -n apt-get update -qq
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential pkg-config git curl
  command -v cargo >/dev/null || curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
  src=$(mktemp -d)
  git clone -q https://github.com/monorepo-labs/dray "$src"
  git -C "$src" checkout -q "$DRAY_REF"
  (cd "$src/apps/cli" && cargo build -q --release)
  (cd "$src/apps/desktop/src-tauri" && cargo build -q --release --no-default-features --features serve --bin dray-serve)
  install -m 755 "$src/apps/cli/target/release/dray" "$src/apps/desktop/src-tauri/target/release/dray-serve" "$HOME/.local/bin/"
  rm -rf "$src"
fi

# Without linger systemd starts no user service at boot, and a machine made
# from this snapshot would come up with no server on it.
step "Turning on linger"
sudo -n loginctl enable-linger "$(id -un)"
[ "$(loginctl show-user "$(id -un)" --property=Linger --value)" = yes ] || { echo "linger is off" >&2; exit 1; }

step "Installing $TOOLS and starting the server"
dray setup --tools "$TOOLS" </dev/null

# setup warns on a tool that failed and starts the server anyway. Run again
# with nothing named and no terminal, it lists what is still missing, judged
# by its own test — the browser's is a set of libraries, not a binary.
missing=$(dray setup </dev/null 2>&1 | sed -n 's/.*Not installed: //p' | tr -d ' ')
failed=
for tool in ${TOOLS//,/ }; do
  case ",$missing," in *",$tool,"*) failed="$failed $tool" ;; esac
done
[ -z "$failed" ] || { echo "did not install:$failed" >&2; exit 1; }

[ "$(systemctl --user show dray --property=OOMPolicy --value)" = continue ] \
  || { echo "the unit has no OOMPolicy=continue; this dray predates #708's fix" >&2; exit 1; }
for _ in $(seq 30); do [ -s "$HOME/.dray/serve-token" ] && break; sleep 1; done
[ -s "$HOME/.dray/serve-token" ] || { echo "the server never wrote its token" >&2; exit 1; }

step "Stopping the server and clearing what is this sandbox's own"
systemctl --user stop dray
# The control plane writes serve-token and cloud.json into every create; the
# rest is this build sandbox's, and every task's machine would start with it.
rm -rf "$HOME/.dray/sessions" "$HOME/.dray/serve-token" "$HOME/.dray/cloud.json" \
  "$HOME/.dray/serve-port" "$HOME/.dray/tunnel-url"

# boat writes a create's files before it reports ready, but nothing says
# before a lingering user service starts. A server up first mints a token of
# its own and never reads the one written over it, so it waits — a minute at
# most, then starts regardless. A resume has both and waits for nothing.
mkdir -p "$HOME/.config/systemd/user/dray.service.d"
cat > "$HOME/.config/systemd/user/dray.service.d/cloud.conf" <<'UNIT'
[Service]
TimeoutStartSec=5min
ExecStartPre=/bin/sh -c 'for i in $$(seq 60); do [ -f %h/.dray/cloud.json ] && [ -f %h/.dray/serve-token ] && exit 0; sleep 1; done'
ExecStartPre=-%h/.local/bin/dray-cloud-update
UNIT

# A machine keeps the disk it was made with, so this is what brings a resumed
# one onto a newer release: systemd starts the server again on every resume
# that gets a new machine, and this runs first. It installs the release the
# release workflow last verified, never merely the newest, so no machine runs
# one that failed verification. A stable release ends in three numbers alone,
# which is what the comparison below relies on. Any failure starts the server
# already there:
# an old server beats none, and the next start tries again.
cat > "$HOME/.local/bin/dray-cloud-update" <<'UPDATE'
#!/bin/sh
url="${DRAY_CLOUD_VERSION_URL:-@VERSION_URL@}"
bin="$HOME/.local/bin"
have="cli-v$("$bin/dray-serve" --version 2>/dev/null | sed -n 's/^dray-serve //p')"
case "$have" in
  cli-v[0-9]*) ;;
  # Built from source on purpose, by DRAY_REF.
  *) echo "dray-cloud-update: not a release ($have); leaving it"; exit 0 ;;
esac
# --retry-connrefused, not --retry-all-errors: a missing file is an answer.
want=$(curl -fsS --max-time 10 --retry 3 --retry-connrefused --retry-max-time 30 "$url" | tr -d '[:space:]')
case "$want" in
  cli-v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "dray-cloud-update: no release read from $url; starting $have"; exit 0 ;;
esac
# Forward only: a machine made from a snapshot saved moments ago can start
# before the workflow moves the pointer up to it.
top=$(printf '%s\n%s\n' "${want#cli-v}" "${have#cli-v}" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
[ "$want" != "$have" ] && [ "$top" = "${want#cli-v}" ] || exit 0
echo "dray-cloud-update: $have -> $want"
t=$(mktemp)
curl -fsSL --max-time 30 --retry 3 https://www.drayhq.com/install.sh -o "$t" \
  && DRAY_INSTALL_DIR="$bin" DRAY_UPDATING=1 DRAY_VERSION="$want" sh "$t" \
  || echo "dray-cloud-update: the install failed; starting $have"
rm -f "$t"
exit 0
UPDATE
sed -i "s|@VERSION_URL@|$VERSION_URL|" "$HOME/.local/bin/dray-cloud-update"
chmod 755 "$HOME/.local/bin/dray-cloud-update"

systemctl --user daemon-reload
systemctl --user is-enabled --quiet dray || { echo "the server is not enabled" >&2; exit 1; }
step "Ready: $(dray-serve --version)"
REMOTE

release=$(b ssh "$id" -- '$HOME/.local/bin/dray-serve --version' | tr -d '\r' | sed -n 's/^dray-serve \([0-9].*\)/cli-v\1/p')
[ -n "${DRAY_REF:-}" ] || [ -z "${DRAY_VERSION:-}" ] || [ "$release" = "$DRAY_VERSION" ] \
  || die "the sandbox runs ${release:-a source build}, not $DRAY_VERSION"

# Stopped, the disk cannot change between the candidate's save and the real
# one, so the disk verified is the disk shipped.
say "Stopping the build sandbox"
b stop "$id" >/dev/null
state() { b info "$1" --json | jq -r .sandbox.state; }
for _ in $(seq 120); do [ "$(state "$id")" = stopped ] && break; sleep 5; done
[ "$(state "$id")" = stopped ] || die "the build sandbox never stopped"

say "Saving the disk as $CANDIDATE"
b snapshot "$id" "$CANDIDATE"

# As the control plane creates one (`create` in apps/web/src/lib/cloud/cloud.ts),
# but with no `dray=cloud` label, so no app ever lists it, and a heartbeat that
# goes nowhere, so it never reports to the real control plane.
say "Creating a machine from $CANDIDATE"
token=$(openssl rand -hex 32)
token_file=$(mktemp)
cloud_file=$(mktemp)
printf '%s' "$token" > "$token_file"
printf '{"url":"http://127.0.0.1:9/api/cloud","secret":"verify"}' > "$cloud_file"
verify_id=$(b new --json --no-env --ttl 1800 --from "$CANDIDATE" --name "dray-cloud verify" \
  --file ".dray/serve-token=$token_file" --file ".dray/cloud.json=$cloud_file" \
  | jq -r 'select(.event == "ready") | .id' | tail -n1)
rm -f "$token_file" "$cloud_file"
[ -n "$verify_id" ] && [ "$verify_id" != null ] || die "boat new reported no ready machine"
say "Verify machine $verify_id"

# Hosted once running, as `hostWhenUp` does: a create's own localhost relay
# never starts (#1003).
host=$(b host "$verify_id" "$PORT" --public --localhost --json | jq -r '[.. | .url? | strings][0] // empty')
sub=$(printf '%s' "$host" | sed -n 's|^https://\([a-z0-9-]*\)-[0-9]*\.on\.boat\.dev.*|\1|p')
[ -n "$sub" ] || die "boat host answered no URL: $host"

say "Connecting the way the app does"
if ! DRAY_VERIFY_TOKEN="$token" node "$here/cloud-verify.mjs" "wss://$sub-$PORT.on.boat.dev" "$protocol" "$release"; then
  b ssh "$verify_id" -- 'systemctl --user status dray --no-pager; journalctl --user -u dray -n 60 --no-pager' || :
  die "a machine made from the build does not work; $NAME is unchanged"
fi

say "Moving $NAME to the verified disk"
b snapshot "$id" "$NAME"
say "Saved. New Dray Cloud machines start from it and run ${release:-a source build}."
