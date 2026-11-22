"""Package the static GlyphCut app with the pinned Windows x64 Electron runtime."""

from hashlib import sha256
from json import dumps
from pathlib import Path
from shutil import copy2, copyfileobj, make_archive
from sys import argv
from tempfile import TemporaryDirectory
from urllib.request import urlopen
from zipfile import ZipFile


ELECTRON_VERSION = "45.4.1"
RUNTIME_NAME = f"electron-v{ELECTRON_VERSION}-win32-x64.zip"
RUNTIME_SHA256 = "2ba6223afa9121f42831fefe92c434334907540165294fc56697449d12e7cfe9"
RUNTIME_URL = f"https://github.com/electron/electron/releases/download/v{ELECTRON_VERSION}/{RUNTIME_NAME}"
DESKTOP = Path(__file__).resolve().parent
ROOT = DESKTOP.parent
PACKAGE = "GlyphCut-Windows-x64"


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
    (target / "electron.exe").rename(target / "GlyphCut.exe")
    (target / "resources" / "default_app.asar").unlink()

    app = target / "resources" / "app"
    (app / "dist").mkdir(parents=True)
    for filename in ("main.cjs", "preload.cjs", "projects.cjs", "updates.cjs", "portable-update.ps1",
                     "workspace.html", "package.json"):
        copy2(DESKTOP / filename, app / filename)
    for filename in ("workspace.js", "workspace.css"):
        copy2(DESKTOP / filename, app / "dist" / filename)
    for filename in ("index.html", "style.css", "geometry.js", "truetype.js", "studio.js"):
        copy2(ROOT / "docs" / filename, app / "dist" / filename)
    copy2(DESKTOP / "使用说明.txt", target / "使用说明.txt")
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
