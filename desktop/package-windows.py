"""Package the static GlyphCut app with the pinned Windows x64 Electron runtime."""

from hashlib import sha256
from json import dumps
from pathlib import Path
from shutil import copy2, copyfileobj, make_archive
from struct import iter_unpack, pack, unpack_from
from sys import argv
from tempfile import TemporaryDirectory
from urllib.request import urlopen
from zipfile import ZipFile

import lief


ELECTRON_VERSION = "45.4.1"
RUNTIME_NAME = f"electron-v{ELECTRON_VERSION}-win32-x64.zip"
RUNTIME_SHA256 = "2ba6223afa9121f42831fefe92c434334907540165294fc56697449d12e7cfe9"
RUNTIME_URL = f"https://github.com/electron/electron/releases/download/v{ELECTRON_VERSION}/{RUNTIME_NAME}"
DESKTOP = Path(__file__).resolve().parent
ROOT = DESKTOP.parent
PACKAGE = "GlyphCut-Windows-x64"
ICON = ROOT / "docs" / "glyphcut.ico"


def set_executable_icon(source: Path, destination: Path) -> None:
    executable = lief.PE.parse(source)
    resources = {node.id: node for node in executable.resources.childs}
    icon_resources = resources[3]  # RT_ICON
    group, = resources[14].childs  # RT_GROUP_ICON
    group_data, = group.childs
    for icon_id in [node.id for node in icon_resources.childs]:
        icon_resources.delete_child(icon_id)

    icon = ICON.read_bytes()
    header_size = 6
    count, = unpack_from("<H", icon, 4)
    group_content = bytearray(icon[:header_size])
    entries = icon[header_size:header_size + count * 16]
    for icon_id, (attributes, size, offset) in enumerate(iter_unpack("<8sII", entries), 1):
        # The PE group references resource IDs in place of the ICO's byte offsets.
        group_content.extend(pack("<8sIH", attributes, size, icon_id))
        image = lief.PE.ResourceData()
        image.content = icon[offset:offset + size]
        image.id = group_data.id
        directory = lief.PE.ResourceDirectory(icon_id)
        directory.add_child(image)
        icon_resources.add_child(directory)
    group_data.content = bytes(group_content)
    executable.write(destination)


def package(runtime: Path, staging: Path) -> Path:
    with runtime.open("rb") as source:
        digest = sha256()
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != RUNTIME_SHA256:
        raise ValueError("Electron runtime SHA-256 mismatch")

    target = staging / PACKAGE
    with ZipFile(runtime) as archive:
        archive.extractall(target)
    electron = target / "electron.exe"
    set_executable_icon(electron, target / "GlyphCut.exe")
    electron.unlink()
    (target / "resources" / "default_app.asar").unlink()

    app = target / "resources" / "app"
    (app / "dist").mkdir(parents=True)
    for filename in ("main.cjs", "preload.cjs", "projects.cjs", "updates.cjs", "portable-update.ps1",
                     "package.json"):
        copy2(DESKTOP / filename, app / filename)
    for filename in ("index.html", "style.css", "workspace.css", "geometry.js", "truetype.js",
                     "web-projects.js", "workspace.js", "studio.js", ICON.name):
        copy2(ROOT / "docs" / filename, app / "dist" / filename)
    copy2(DESKTOP / "使用说明.txt", target / "使用说明.txt")
    copy2(ROOT / "LICENSE", target / "GlyphCut-LICENSE.txt")
    manifest = target / "portable-files.json"
    files = sorted([item.name for item in target.iterdir()] + [manifest.name])
    manifest.write_text(dumps(files) + "\n", encoding="utf-8")
    return Path(make_archive(str(ROOT / PACKAGE), "zip", staging, PACKAGE))


if __name__ == "__main__":
    with TemporaryDirectory() as temporary:
        staging = Path(temporary)
        if len(argv) > 1:
            runtime = Path(argv[1])
        else:
            runtime = staging / RUNTIME_NAME
            print(f"Downloading {RUNTIME_NAME}", flush=True)
            with urlopen(RUNTIME_URL, timeout=60) as source, runtime.open("wb") as destination:
                copyfileobj(source, destination)
        print(package(runtime, staging))
