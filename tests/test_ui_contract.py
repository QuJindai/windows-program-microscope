import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class UiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "app" / "index.html").read_text(encoding="utf-8")
        cls.css = (ROOT / "app" / "styles.css").read_text(encoding="utf-8")
        cls.js = (ROOT / "app" / "app.js").read_text(encoding="utf-8")

    def test_shell_exposes_six_lenses_and_timeline(self):
        for lens in ("overview", "timeline", "flow", "state", "io", "compare"):
            self.assertIn(f'data-lens="{lens}"', self.html)
        self.assertIn('id="timeline-footer"', self.html)

    def test_truth_badges_and_capture_modes_are_visible(self):
        for truth in ("REAL", "DERIVED", "UNAVAILABLE", "DEBUG_ONLY"):
            self.assertIn(truth, self.js)
        for mode in ("observe", "deep_trace", "time_travel"):
            self.assertIn(mode, self.js)

    def test_no_external_frontend_dependency(self):
        self.assertNotIn("react", self.html.lower())
        self.assertNotIn("https://", self.html)
        self.assertIn("font-family", self.css)


if __name__ == "__main__":
    unittest.main()

