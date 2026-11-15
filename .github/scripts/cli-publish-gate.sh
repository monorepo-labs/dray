#!/usr/bin/env bash
# Holds a CLI release whose protocol moved until an app release speaking it is
# out, so the `v*` and `cli-v*` tags can always be pushed together.
#
# The order matters one way only: a CLI behind the app is cured by `dray
# update`, which agents run themselves; an app behind the CLI needs a human.
#
#   cli-publish-gate.sh decide <cli-tag>
#     "not moved", or "moved, wait for v<app>". Git alone, so it runs anywhere
#     the tags are fetched.
#   cli-publish-gate.sh wait <app-tag> <protocol>
#     Polls until that app release's `manifest` job is done — the updater
#     manifest is what reaches clients, so a GitHub release existing is too
#     early. GATE_TIMEOUT (default 2700s) caps it; 0 checks once.
#
# Outputs go to $GITHUB_OUTPUT where it is set.
set -euo pipefail

proto_file=crates/dray-proto/src/lib.rs
repo=${GITHUB_REPOSITORY:-monorepo-labs/dray}

die() { echo "::error::$*" >&2; exit 1; }
out() { [ -z "${GITHUB_OUTPUT:-}" ] || printf '%s\n' "$@" >> "$GITHUB_OUTPUT"; }
protocol_at() {
  git show "$1:$proto_file" | sed -n 's/^pub const PROTOCOL_VERSION: u32 = \([0-9]*\);$/\1/p'
}

decide() {
  local tag=$1 now prev before app
  now=$(protocol_at "$tag")
  [ -n "$now" ] || die "no PROTOCOL_VERSION in $proto_file at $tag"

  # A stable CLI is measured against the last stable one, since stable users
  # never had the betas in between; a beta against whatever shipped last.
  local skip=()
  case ${tag#cli-v} in *-*) ;; *) skip=(--exclude 'cli-v*-*') ;; esac
  prev=$(git describe --tags --abbrev=0 --match 'cli-v*' "${skip[@]}" "$tag^" 2>/dev/null || true)
  before=${prev:+$(protocol_at "$prev")}

  if [ -n "$prev" ] && [ "$before" = "$now" ]; then
    echo "not moved: protocol $now at $tag, as at $prev"
    out moved=false
    return
  fi

  app=v$(git show "$tag:apps/desktop/src-tauri/tauri.conf.json" | jq -r .version)
  # No earlier tag means nothing to compare with, so take the safe side.
  echo "moved, wait for $app: protocol $now at $tag, ${before:-none} at ${prev:-no earlier cli-v tag}"
  out moved=true "app-tag=$app" "protocol=$now"
}

# One look. Prints "done", "wait <why>" or "fail <why>".
check() {
  local app=$1 want=$2 have run id status conclusion manifest
  if ! git fetch -q origin "refs/tags/$app:refs/tags/$app" 2>/dev/null; then
    echo "wait $app is not pushed yet"; return
  fi
  have=$(protocol_at "$app")
  if [ "$have" != "$want" ]; then
    echo "fail $app speaks protocol ${have:-none} and this CLI $want, so no app release will ever carry it; tag the app from this commit"
    return
  fi

  run=$(gh api "repos/$repo/actions/workflows/release.yml/runs?event=push&branch=$app&per_page=1" \
    --jq '.workflow_runs[0] // empty | [.id, .status, .conclusion // ""] | @tsv')
  if [ -z "$run" ]; then
    echo "wait no Release run for $app yet"; return
  fi
  IFS=$'\t' read -r id status conclusion <<< "$run"
  # The jobs read answers the latest attempt, so a re-run app release counts.
  manifest=$(gh api "repos/$repo/actions/runs/$id/jobs?per_page=100" \
    --jq '.jobs[] | select(.name == "manifest") | [.status, .conclusion // ""] | @tsv')

  case $manifest in
    $'completed\tsuccess') echo "done" ;;
    completed*) echo "fail $app's manifest job ended ${manifest#*$'\t'} (run $id)" ;;
    *)
      if [ "$status" = completed ]; then
        echo "fail $app's Release run ended $conclusion before its manifest job ran (run $id)"
      else
        echo "wait $app's Release run $id is $status"
      fi
      ;;
  esac
}

wait_for() {
  local app=$1 want=$2 cap=${GATE_TIMEOUT:-2700} every=${GATE_EVERY:-30}
  local deadline=$((SECONDS + cap)) state
  while :; do
    state=$(check "$app" "$want")
    case $state in
      done) echo "$app is out, protocol $want"; return ;;
      fail*) die "${state#fail }. Re-run this job once that is fixed." ;;
    esac
    echo "${state#wait } ($((SECONDS))s)"
    [ "$SECONDS" -lt "$deadline" ] || die "Waited ${cap}s for app release $app (protocol $want) to finish its manifest job; last seen: ${state#wait }. Protocol moved, so the CLI publishes only after the app. Re-run this job once $app is out."
    sleep "$every"
  done
}

case ${1:-} in
  decide) decide "$2" ;;
  wait) wait_for "$2" "$3" ;;
  *) echo "usage: $0 decide <cli-tag> | wait <app-tag> <protocol>" >&2; exit 2 ;;
esac
