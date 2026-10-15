#!/bin/sh
# Pulls the channel resolver out of install.sh and runs it against fixed tag
# lists, newest first as the releases API answers. Run by installer.rs, so
# release-cli's test job runs it under Ubuntu's dash as well as macOS's sh.
set -eu
src="$1"
eval "$(sed -n '/^newer() {/,/^}/p;/^newest_of() {/,/^}/p;/^resolve_version() {/,/^}/p' "$src")"
check() { # channel tags expected
  CHANNEL=$1; TAGS=$2
  cli_tags() { printf '%s\n' $TAGS; }
  got=$(resolve_version)
  [ "$got" = "$3" ] && echo "ok   $1: $got" || { echo "FAIL $1: got '$got' want '$3' from: $2"; exit 1; }
}
check stable "cli-v0.12.0-beta.2 cli-v0.12.0-beta.1 cli-v0.11.0" cli-v0.11.0
check beta   "cli-v0.12.0-beta.2 cli-v0.12.0-beta.1 cli-v0.11.0" cli-v0.12.0-beta.2
# stable hotfix cut after a newer beta: beta stays put
check beta   "cli-v0.11.1 cli-v0.12.0-beta.2 cli-v0.11.0" cli-v0.12.0-beta.2
# the release a beta led up to replaces it
check beta   "cli-v0.12.0 cli-v0.12.0-beta.2 cli-v0.11.0" cli-v0.12.0
# numeric, not lexical: 0.10 > 0.9
check beta   "cli-v0.9.5 cli-v0.10.0-beta.1" cli-v0.10.0-beta.1
check beta   "cli-v0.11.0" cli-v0.11.0
check beta   "cli-v0.12.0-beta.1" cli-v0.12.0-beta.1
check stable "cli-v0.12.0-beta.1" ""

# `newer` also decides that a beta left for stable is kept, not downgraded.
order() { # a b expected(yes|no)
  if newer "$1" "$2"; then got=yes; else got=no; fi
  [ "$got" = "$3" ] && echo "ok   newer $1 $2: $got" || { echo "FAIL newer $1 $2: got $got want $3"; exit 1; }
}
order cli-v0.12.0-beta.10 cli-v0.12.0-beta.9 yes
order cli-v0.12.0 cli-v0.12.0-beta.3 yes
order cli-v0.11.1 cli-v0.12.0-beta.1 no
order cli-v0.12.0-beta.1 cli-v0.12.0-beta.1 no
