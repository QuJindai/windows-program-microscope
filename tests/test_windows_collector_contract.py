"""Dependency constraints only; ETW behavior is verified by tests/windows/test_capture.ps1."""
import unittest
from pathlib import Path
import xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[1]

class WindowsCollectorDependencyTests(unittest.TestCase):
    def test_project_pins_the_reviewed_windows_traceevent_dependency(self):
        project=ET.parse(ROOT/'collector/windows/ProgramMicroscope.Collector.csproj')
        self.assertEqual(project.findtext('.//TargetFramework'),'net8.0-windows')
        package=project.find('.//PackageReference[@Include="Microsoft.Diagnostics.Tracing.TraceEvent"]')
        self.assertIsNotNone(package)
        self.assertEqual(package.get('Version'),'3.2.6')
