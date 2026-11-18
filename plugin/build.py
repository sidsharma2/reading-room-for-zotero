#!/usr/bin/env python3
"""Build reading-room-tools.xpi. Fetches one pinned MathLive release and checks it against the npm integrity hash."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import tarfile
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MATHLIVE_VERSION = "0.111.1"
MATHLIVE_URL = f"https://registry.npmjs.org/mathlive/-/mathlive-{MATHLIVE_VERSION}.tgz"
MATHLIVE_SHA512 = "RVaC7NO02Lmx3ZNUxOHR2xCRpcvTfBb2BtdgV60cTanAMufaUkWcPPB2VxChcsNeL+0rTQKqOPDYxXLPOXJI+A=="
CACHE = HERE / ".cache" / f"mathlive-{MATHLIVE_VERSION}.tgz"
OUTPUT = HERE / "reading-room-tools.xpi"
OURS = ["manifest.json", "bootstrap.js", "connections.js", "organise.js", "tools.js", "content/web.xhtml", "content/web-host.js", "content/web.html", "content/web.css", "content/web.js", "content/host.xhtml", "content/host.js", "content/equation.html", "content/equation.js", "content/equation.css"]


def mathlive_archive() -> bytes:
    if not CACHE.exists():
        CACHE.parent.mkdir(exist_ok=True)
        with urllib.request.urlopen(MATHLIVE_URL, timeout=60) as reply:
            CACHE.write_bytes(reply.read())
    data = CACHE.read_bytes()
    found = base64.b64encode(hashlib.sha512(data).digest()).decode()
    if found != MATHLIVE_SHA512:
        CACHE.unlink()
        raise SystemExit(f"MathLive hash does not match: {found}")
    return data


def vendored() -> dict[str, bytes]:
    """The script, its licence and its fonts. The sounds and the other builds are left out."""
    files: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(mathlive_archive())) as archive:
        for member in archive.getmembers():
            name = member.name.removeprefix("package/")
            keep = name in ("mathlive.min.js", "LICENSE.txt") or (name.startswith("fonts/") and name.endswith(".woff2"))
            if member.isfile() and keep:
                files[f"content/vendor/{name}"] = archive.extractfile(member).read()
    return files


def add(package: zipfile.ZipFile, name: str, data: bytes) -> None:
    """A fixed date, mode and system, so the same sources give the same file, and the same hash, on every machine.
    zipfile marks each entry as made on Windows (0) or Unix (3) by the machine it runs on, so that is fixed too."""
    info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o644 << 16
    package.writestr(info, data)


def main() -> int:
    version = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))["version"]
    with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as package:
        for name in OURS:
            add(package, name, (HERE / name).read_bytes().replace(b"\r\n", b"\n"))
        for name, data in sorted(vendored().items()):
            add(package, name, data)
    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    print(f"{OUTPUT.name} {version} {OUTPUT.stat().st_size} bytes sha256 {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
