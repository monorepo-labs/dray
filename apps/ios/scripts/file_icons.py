#!/usr/bin/env python3
"""Copies the desktop's file icons (vscode-material-icons) into the iOS app.

Writes one vector imageset per icon under Dray/Assets.xcassets/FileIcons and
the name lookup to Dray/file-icons.json, so the phone picks the same glyph the
desktop's FileIcon does. Run after bumping the package in apps/desktop:

    python3 apps/ios/scripts/file_icons.py
"""
import json
import pathlib
import shutil

ios = pathlib.Path(__file__).resolve().parent.parent
desktop = ios.parent / "desktop"
# The desktop's own copy, so both apps draw from one version (`pnpm install` first).
pkg = (desktop / "node_modules" / "vscode-material-icons").resolve()
icons = pkg / "generated" / "icons"
iconmap = json.loads((pkg / "generated" / "icon-map.json").read_text())

out = ios / "Dray" / "Assets.xcassets" / "FileIcons"
shutil.rmtree(out, ignore_errors=True)
out.mkdir()
(out / "Contents.json").write_text(json.dumps({"info": {"author": "xcode", "version": 1}}, indent=2) + "\n")

# html, typescript and javascript are the package's hand-written fallbacks, named in no map.
names = {"file", "folder", "html", "typescript", "javascript"} | set(iconmap["fileNames"].values()) \
    | set(iconmap["fileExtensions"].values()) | set(iconmap["folderNames"].values())
for name in sorted(names):
    svg = icons / f"{name}.svg"
    if not svg.exists():
        continue
    folder = out / f"fi-{name}.imageset"
    folder.mkdir()
    shutil.copy(svg, folder / f"{name}.svg")
    (folder / "Contents.json").write_text(json.dumps({
        "images": [{"filename": f"{name}.svg", "idiom": "universal"}],
        "info": {"author": "xcode", "version": 1},
    }, indent=2) + "\n")

lookup = {k: iconmap[k] for k in ("fileNames", "fileExtensions", "folderNames")}
(ios / "Dray" / "file-icons.json").write_text(json.dumps(lookup, separators=(",", ":"), sort_keys=True) + "\n")
print(f"{len(list(out.glob('*.imageset')))} icons")
