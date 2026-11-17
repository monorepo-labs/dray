#!/usr/bin/env bash
# Vercel's Ignored Build Step for apps/web and apps/docs: exit 0 skips the
# deployment, exit 1 builds it. Arguments are the repo paths that project's
# build reads; anything going wrong builds, since a skipped build that should
# have run is the one failure nobody notices.
#
# Vercel's own "skip unaffected projects" lets about half of all pushes
# through, and it cannot know apps/web reads apps/desktop/CHANGELOG.md.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1

# Vercel's checkout is shallow and may carry no remote, so fetch by URL. The
# repository is public.
repo="https://github.com/${VERCEL_GIT_REPO_OWNER:-monorepo-labs}/${VERCEL_GIT_REPO_SLUG:-dray}.git"
ref=${VERCEL_GIT_COMMIT_REF:-}
base=${VERCEL_GIT_PREVIOUS_SHA:-}

echo "ref=$ref env=${VERCEL_ENV:-} previous=${base:-none} head=$(git rev-parse HEAD)"

if [ -z "$base" ]; then
  if [ "$ref" = main ]; then
    echo "No previous deployment of main: building."
    exit 1
  fi
  # A branch's first deployment: compare with where it left main, since a
  # branch changing none of these paths would only preview main again. Main's
  # tip instead would build every branch forked before a site change landed.
  git fetch -q --depth=200 "$repo" main || { echo "Could not fetch main: building."; exit 1; }
  main=$(git rev-parse FETCH_HEAD)
  git fetch -q --deepen=200 "$repo" "$(git rev-parse HEAD)" 2>/dev/null
  base=$(git merge-base "$main" HEAD 2>/dev/null) || base=$main
  echo "First deployment of $ref: comparing with main at $base."
elif ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  git fetch -q --depth=1 "$repo" "$base" || { echo "Could not fetch $base: building."; exit 1; }
fi

git diff --quiet "$base" HEAD -- "$@"
case $? in
  0) echo "Nothing under $* changed: skipping."; exit 0 ;;
  1) echo "Changed:"; git diff --name-only "$base" HEAD -- "$@" | head -20; exit 1 ;;
  *) echo "git diff failed: building."; exit 1 ;;
esac
