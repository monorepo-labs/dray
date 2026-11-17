#!/usr/bin/env bash
# Checks vercel-ignore-build.sh's verdicts against a local remote and a
# shallow, remoteless clone of it, the way Vercel checks a branch out.
#   bash scripts/vercel-ignore-build.test.sh
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/vercel-ignore-build.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q -b main "$tmp/src"
cd "$tmp/src"
commit() { mkdir -p "$(dirname "$1")"; echo "$RANDOM" >> "$1"; git add -A; git commit -qm "$1"; git rev-parse HEAD; }

c_web=$(commit apps/web/page.tsx)
fork=$(commit apps/ios/a.swift)
main_web=$(commit apps/web/page.tsx)
git checkout -q -b feature "$fork"
for i in $(seq 12); do commit apps/ios/a.swift >/dev/null; done
f_ios=$(git rev-parse HEAD)
git checkout -q -b feature-web
f_web=$(commit apps/web/page.tsx)

git clone -q --bare "$tmp/src" "$tmp/remote.git"
# GitHub serves any commit by sha; a local remote must be told to.
git -C "$tmp/remote.git" config uploadpack.allowAnySHA1InWant true

fails=0
check() { # check <want-exit> <description> <branch> [previous-sha]
  local want=$1 what=$2 branch=$3 prev=${4:-} dir="$tmp/clone-$RANDOM" got=0
  git clone -q --depth=5 --branch "$branch" "file://$tmp/remote.git" "$dir"
  git -C "$dir" remote remove origin
  (cd "$dir" && VERCEL_IGNORE_REPO="file://$tmp/remote.git" VERCEL_GIT_COMMIT_REF=$branch \
    VERCEL_GIT_PREVIOUS_SHA=$prev bash "$script" apps/web) >"$dir.log" 2>&1 || got=$?
  if [ "$got" = "$want" ]; then echo "ok   $what"; else echo "FAIL $what: exit $got, want $want"; sed 's/^/     /' "$dir.log"; fails=1; fi
}

check 0 "unchanged since previous deploy" feature "$f_ios"
check 0 "previous deploy outside the shallow clone, fetched" feature "$fork"
check 1 "changed since previous deploy" feature-web "$f_ios"
check 1 "previous deploy unfetchable" feature "$(printf 'f%.0s' $(seq 40))"
check 1 "main with no previous deploy" main
check 0 "first deploy of a branch with nothing changed since its fork" feature
check 1 "first deploy of a branch that changed the path" feature-web
check 0 "main unchanged since previous deploy" main "$main_web"
check 1 "main changed since previous deploy" main "$c_web"

exit $fails
