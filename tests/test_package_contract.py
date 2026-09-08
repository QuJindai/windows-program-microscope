import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools import package


class PackageContractTests(unittest.TestCase):
    def test_source_package_excludes_generated_and_secret_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['app/index.html', 'src-tauri/Cargo.lock', 'docs/report.md',
                         'node_modules/a/index.js', 'src-tauri/target/app.exe',
                         'collector/windows/bin/app.exe', 'collector/windows/obj/cache',
                         '.git/config', '.venv/bin/python', 'dist/old.zip',
                         '.env', '.env.local', '.toolchains/sdk', 'test-results/log']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(name)
            with patch.object(package, 'ROOT', root):
                files = {str(path.relative_to(root)) for path in package.package_files()}
            self.assertEqual(files, {'app/index.html', 'src-tauri/Cargo.lock', 'docs/report.md'})

    def test_real_source_package_excludes_build_outputs(self):
        excluded = {'node_modules', 'target', 'bin', 'obj', '.git', '.toolchains'}
        self.assertFalse([str(p) for p in package.package_files() if excluded.intersection(p.parts)])
