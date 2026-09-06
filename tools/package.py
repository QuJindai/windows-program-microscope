#!/usr/bin/env python3
"""Build and validate a portable source package."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def package_files() -> list[Path]:
    ignored = {".git", "dist", "__pycache__"}
    return sorted(path for path in ROOT.rglob("*") if path.is_file() and not any(part in ignored for part in path.parts))


def main() -> int:
    tests = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], cwd=ROOT, check=False)
    if tests.returncode:
        return tests.returncode
    DIST.mkdir(exist_ok=True)
    archive = DIST / "program-microscope-v0.1.0-source.zip"
    if archive.exists():
        archive.unlink()
    files = package_files()
    with ZipFile(archive, "w", ZIP_DEFLATED) as output:
        for path in files:
            output.write(path, Path("windows-program-microscope") / path.relative_to(ROOT))

    with tempfile.TemporaryDirectory(prefix="microscope-package-") as temp:
        extracted = Path(temp) / "extract"
        with ZipFile(archive) as zipped:
            zipped.extractall(extracted)
        recovered = sorted(path.relative_to(extracted) for path in extracted.rglob("*") if path.is_file())
        expected = sorted(Path("windows-program-microscope") / path.relative_to(ROOT) for path in files)
        if recovered != expected:
            raise RuntimeError("archive verification failed: extracted file list differs")

    manifest = {"package": archive.name, "sha256": sha256(archive), "files": len(files), "schema_version": "0.1"}
    (DIST / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

