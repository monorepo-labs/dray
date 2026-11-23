#!/usr/bin/env bash
# The Windows half of an app release, release.yml's `manifest` job. <dir>
# holds the `windows` job's artifact as it downloads: the NSIS installer, the
# MSI on a stable release, a `.sig` beside each.
#
#   windows-release.sh files <dir>
#     Every installer under <dir>, one path a line.
#   windows-release.sh entries <manifest.json> <dir> <url-base>
#     Writes each installer's updater entry into the manifest, URLs under
#     <url-base>: `windows-x86_64-nsis` and `windows-x86_64-msi`. No bare
#     `windows-x86_64`, which the updater falls back to: an MSI install offered
#     the NSIS installer would end up installed twice, once per user and once
#     per machine. A beta carries no MSI, so an MSI install waits for stable.
#   windows-release.sh latest <dir> <tag>
#     Copies each installer on R2 from under <tag>/ to its versionless name,
#     the one a download link names: Dray_x64-setup.exe, Dray_x64.msi.
set -euo pipefail

files() {
  find "$1" -type f \( -name '*-setup.exe' -o -name '*.msi' \) | sort
}

case "${1:-}" in
  files)
    files "$2"
    ;;

  entries)
    manifest=$2 dir=$3 base=${4%/}
    nsis=0
    while IFS= read -r f; do
      name=$(basename "$f")
      test -s "$f.sig" || { echo "$name has no signature" >&2; exit 1; }
      case "$name" in
        *_x64-setup.exe) k=windows-x86_64-nsis nsis=$((nsis + 1)) ;;
        *_x64_*.msi) k=windows-x86_64-msi ;;
        *) echo "no arch in $name" >&2; exit 1 ;;
      esac
      jq --arg k "$k" --arg url "$base/$name" --arg sig "$(cat "$f.sig")" \
        '.platforms[$k] = {signature: $sig, url: $url}' "$manifest" > "$manifest.tmp"
      mv "$manifest.tmp" "$manifest"
    done < <(files "$dir")
    [ "$nsis" -eq 1 ] || { echo "expected one NSIS installer under $dir, found $nsis" >&2; exit 1; }
    ;;

  latest)
    dir=$2 tag=$3
    : "${R2_BUCKET:?}" "${R2_ACCOUNT_ID:?}"
    while IFS= read -r f; do
      name=$(basename "$f")
      case "$name" in
        *-setup.exe) to=Dray_x64-setup.exe type=application/vnd.microsoft.portable-executable ;;
        *.msi) to=Dray_x64.msi type=application/x-msi ;;
      esac
      aws s3 cp "s3://${R2_BUCKET}/${tag}/${name}" "s3://${R2_BUCKET}/${to}" \
        --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
        --metadata-directive REPLACE \
        --content-type "$type" \
        --cache-control "public, max-age=300"
    done < <(files "$dir")
    ;;

  *)
    echo "usage: $0 files <dir> | entries <manifest.json> <dir> <url-base> | latest <dir> <tag>" >&2
    exit 1
    ;;
esac
