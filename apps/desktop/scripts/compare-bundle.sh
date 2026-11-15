#!/bin/sh
# Describes two Dray.app bundles the same way and diffs the descriptions: what
# a dry run of release.yml checks a pipeline change against the last release
# with. Every file with its size, then per signed piece its signature, its
# entitlements and its arches, then each Info.plist.
#
#   compare-bundle.sh <reference.app> <candidate.app> <out-dir>
#
# Writes reference.txt, candidate.txt and diff.txt into <out-dir> and prints
# the diff. Exits 0 on any difference: some always differ (cdhash, signing
# time, the notarization ticket), so reading the diff is a person's job.
set -eu
[ $# -eq 3 ] || { echo "usage: $0 <reference.app> <candidate.app> <out-dir>" >&2; exit 1; }
mkdir -p "$3"
OUT=$(cd "$3" && pwd)

describe() (
  cd "$1"
  echo "## files"
  find . -type f -exec stat -f '%z %N' {} + | sort -k2
  echo "## links"
  find . -type l -exec stat -f '%N -> %Y' {} + | sort
  echo "## total"
  du -sk . | cut -f1
  # Carried into the dmg's filesystem, so they move its size with no file
  # changing; codesign ignores them.
  echo "## xattrs"
  find . -exec sh -c 'for f; do a=$(xattr "$f" 2>/dev/null | sort | tr "\n" " "); [ -z "$a" ] || echo "$f: $a"; done' _ {} + | sort

  # Nested bundles first, then every Mach-O, so a binary the bundler copied
  # in unsigned shows up as well as one it signed.
  { echo .; find . -name '*.app' -type d; } | sort > "$OUT/.bundles"
  find . -type f -perm -u+x -exec sh -c 'file -b "$1" | grep -q Mach-O && echo "$1"' _ {} \; | sort > "$OUT/.machos"
  while IFS= read -r p; do
    echo "## sign $p"
    codesign -dv --verbose=4 "$p" 2>&1 | sed '/^Executable=/d'
    codesign --verify --strict "$p" 2>&1 && echo "verify: ok"
    echo "## entitlements $p"
    codesign -d --entitlements :- "$p" 2>/dev/null | plutil -convert xml1 -o - - 2>/dev/null || echo "(none)"
    echo "## Info.plist $p"
    plutil -convert xml1 -o - "$p/Contents/Info.plist"
  done < "$OUT/.bundles"
  while IFS= read -r p; do
    echo "## binary $p"
    echo "arches: $(lipo -archs "$p")"
    codesign -dv --verbose=2 "$p" 2>&1 | grep -E '^(Identifier|Format|CodeDirectory|Authority|TeamIdentifier|Runtime Version)'
    # The code's own fingerprint, per arch: a binary changed at the same
    # size and identity shows here and nowhere else. Signing time is not in
    # it, so a rebuild of the same source matches.
    for a in $(lipo -archs "$p"); do
      echo "cdhash $a: $(codesign -dv --verbose=4 --arch "$a" "$p" 2>&1 | sed -n 's/^CDHash=//p')"
    done
    echo "## entitlements $p"
    codesign -d --entitlements :- "$p" 2>/dev/null | plutil -convert xml1 -o - - 2>/dev/null || echo "(none)"
  done < "$OUT/.machos"
  echo "## gatekeeper"
  xcrun stapler validate "$PWD" 2>&1 | tail -1
  spctl --assess --type exec -vv "$PWD" 2>&1 | sed "s#$PWD#<app>#"
)

describe "$1" > "$OUT/reference.txt"
describe "$2" > "$OUT/candidate.txt"
rm -f "$OUT/.bundles" "$OUT/.machos"
diff -u "$OUT/reference.txt" "$OUT/candidate.txt" > "$OUT/diff.txt" || true
cat "$OUT/diff.txt"
