#!/usr/bin/env python3
"""Build and validate a portable source package."""

from __future__ import annotations

import hashlib
import json
import os
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
    ignored = {".git", "dist", "__pycache__", "node_modules", "target", "bin", "obj",
               ".venv", ".toolchains", "test-results", ".idea", ".vs", ".pytest_cache"}
    files = []
    for directory, folders, names in os.walk(ROOT, followlinks=False):
        folders[:] = [name for name in folders if name not in ignored and
                      not (Path(directory) / name).is_symlink()]
        for name in names:
            path = Path(directory) / name
            if path.is_symlink() or name == ".env" or name.startswith(".env."):
                continue
            files.append(path)
    return sorted(files)


def main() -> int:
    tests = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], cwd=ROOT, check=False)
    if tests.returncode:
        return tests.returncode
    DIST.mkdir(exist_ok=True)
    archive = DIST / "program-microscope-v0.2.0-source.zip"
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

        for path in files:
            copy = extracted / "windows-program-microscope" / path.relative_to(ROOT)
            if sha256(copy) != sha256(path):
                raise RuntimeError(f"archive content verification failed: {path.relative_to(ROOT)}")

    manifest = {"package": archive.name, "sha256": sha256(archive), "files": len(files), "schema_version": "0.1"}
    (DIST / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

