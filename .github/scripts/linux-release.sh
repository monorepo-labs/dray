#!/usr/bin/env bash
# The Linux half of an app release, shared by release.yml's `manifest` and
# `linux-publish` jobs. <dir> holds the `linux` job's artifacts as they
# download, one folder per arch: an AppImage and a .deb, a `.sig` beside each.
#
#   linux-release.sh files <dir>
#     Every AppImage and .deb under <dir>, one path a line.
#   linux-release.sh entries <manifest.json> <dir> <url-base>
#     Writes each file's updater entries into the manifest, URLs under
#     <url-base>. The updater asks for `linux-<arch>-<bundle>` first, then
#     `linux-<arch>`, which names the AppImage as it always has: an app from
#     before the .deb only ever asks for that and `-appimage`.
#   linux-release.sh latest <dir> <tag>
#     Copies each file on R2 from under <tag>/ to its versionless name, the
#     one a download link names: Dray_amd64.AppImage, Dray_arm64.deb, …
set -euo pipefail

files() {
  find "$1" -type f \( -name '*.AppImage' -o -name '*.deb' \) | sort
}

# Tauri names an x86_64 AppImage `amd64` and an arm64 one `aarch64`; the .deb
# takes Debian's names for both.
arch_of() {
  case "$1" in
    *_amd64.AppImage | *_amd64.deb) echo x86_64 ;;
    *_aarch64.AppImage | *_arm64.deb) echo aarch64 ;;
    *) echo "no arch in $1" >&2; return 1 ;;
  esac
}

debian_arch() {
  case "$1" in x86_64) echo amd64 ;; aarch64) echo arm64 ;; esac
}

case "${1:-}" in
  files)
    files "$2"
    ;;

  entries)
    manifest=$2 dir=$3 base=${4%/}
    n=0
    while IFS= read -r f; do
      name=$(basename "$f")
      arch=$(arch_of "$name")
      test -s "$f.sig" || { echo "$name has no signature" >&2; exit 1; }
      case "$name" in
        *.AppImage) keys=("linux-$arch" "linux-$arch-appimage") ;;
        *.deb) keys=("linux-$arch-deb") ;;
      esac
      for k in "${keys[@]}"; do
        jq --arg k "$k" --arg url "$base/$name" --arg sig "$(cat "$f.sig")" \
          '.platforms[$k] = {signature: $sig, url: $url}' "$manifest" > "$manifest.tmp"
        mv "$manifest.tmp" "$manifest"
      done
      n=$((n + 1))
    done < <(files "$dir")
    # Two arches, two formats. Fewer is a leg that built nothing.
    [ "$n" -eq 4 ] || { echo "expected 4 Linux files under $dir, found $n" >&2; exit 1; }
    ;;

  latest)
    dir=$2 tag=$3
    : "${R2_BUCKET:?}" "${R2_ACCOUNT_ID:?}"
    while IFS= read -r f; do
      name=$(basename "$f")
      arch=$(debian_arch "$(arch_of "$name")")
      case "$name" in
        *.AppImage) to="Dray_$arch.AppImage" type=application/vnd.appimage ;;
        *.deb) to="Dray_$arch.deb" type=application/vnd.debian.binary-package ;;
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
