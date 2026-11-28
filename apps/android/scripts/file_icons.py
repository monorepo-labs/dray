#!/usr/bin/env python3
"""Copies the desktop's file icons (vscode-material-icons) into the Android app.

Writes one SVG per icon under app/src/main/assets/file-icons and the name lookup
to app/src/main/assets/file-icons.json, so the phone picks the same glyph the
desktop's FileIcon and the iOS app do. Run after bumping the package in apps/desktop:

    python3 apps/android/scripts/file_icons.py
"""
import json
import pathlib
import shutil

android = pathlib.Path(__file__).resolve().parent.parent
desktop = android.parent / "desktop"
# The desktop's own copy, so every app draws from one version (`pnpm install` first).
pkg = (desktop / "node_modules" / "vscode-material-icons").resolve()
icons = pkg / "generated" / "icons"
iconmap = json.loads((pkg / "generated" / "icon-map.json").read_text())

assets = android / "app" / "src" / "main" / "assets"
out = assets / "file-icons"
shutil.rmtree(out, ignore_errors=True)
out.mkdir(parents=True)

# html, typescript and javascript are the package's hand-written fallbacks, named in no map.
names = {"file", "folder", "html", "typescript", "javascript"} | set(iconmap["fileNames"].values()) \
    | set(iconmap["fileExtensions"].values()) | set(iconmap["folderNames"].values())
for name in sorted(names):
    svg = icons / f"{name}.svg"
    if svg.exists():
        shutil.copy(svg, out / f"{name}.svg")

lookup = {k: iconmap[k] for k in ("fileNames", "fileExtensions", "folderNames")}
(assets / "file-icons.json").write_text(json.dumps(lookup, separators=(",", ":"), sort_keys=True) + "\n")
print(f"{len(list(out.glob('*.svg')))} icons")
