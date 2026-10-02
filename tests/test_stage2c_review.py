"""
Offline tests for stage2c_review.py (Stage 2C1): staging-path refusal, safe evidence encoding,
exact date-based comparison statistics and the report pipeline. No provider request; every
write is inside a temporary directory.

Run from the project root:   py tests/test_stage2c_review.py
"""
import hashlib
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import commodity_tracker as ct  # noqa: E402
import stage2c_review as sr  # noqa: E402

NOW = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)


class TestStagingSafety(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.root = self._td.name

    def tearDown(self):
        self._td.cleanup()

    def test_valid_staging_resolves_inside_staging(self):
        p = sr.resolve_staging(self.root, "staging_stage2c1_20260930_000000")
        base = os.path.realpath(os.path.join(self.root, "staging_stage2c1_20260930_000000"))
        self.assertEqual(p["dataset"], os.path.join(base, ct.DATASET_FILE))
        self.assertEqual(p["sidecar"], os.path.join(base, ct.SIDECAR_FILE))

    def test_refuses_bad_names_and_traversal(self):
        for bad in ("commodities", ".", "..", "", "staging_stage2c1_x/..", "staging_stage2c1_x/../..",
                    os.path.join("sub", "staging_stage2c1_x")):
            with self.subTest(bad), self.assertRaises(ValueError):
                sr.resolve_staging(self.root, bad)

    def test_refuses_when_sidecar_or_dataset_would_leave_staging_or_hit_production(self):
        name = "staging_stage2c1_20260930_000000"
        with mock.patch.object(ct, "SIDECAR_FILE", os.path.join("..", "commodities_data_meta.json")):
            with self.assertRaises(ValueError):
                sr.resolve_staging(self.root, name)
        with mock.patch.object(ct, "DATASET_FILE", os.path.join("..", "commodities_data.json")):
            with self.assertRaises(ValueError):
                sr.resolve_staging(self.root, name)


class TestEvidenceEncoding(unittest.TestCase):
    def test_invalid_values_become_strict_json(self):
        vals = [1.5, 2, None, float("nan"), float("inf"), float("-inf"), "x", True, object]
        enc = [sr.encode_value(v) for v in vals]
        self.assertEqual(enc[:8], [1.5, 2, None, "NaN", "Infinity", "-Infinity", "str:x", "bool:True"])
        self.assertTrue(enc[8].startswith("other:"))
        json.dumps(enc, allow_nan=False)                          # does not raise

    def test_build_evidence_keeps_every_returned_row_and_counts_kinds(self):
        rec = sr.RecordingDownloader(lambda s, a, b, **o: {
            "GC=F": {"dates": ["2026-09-01", "2026-09-02", "2026-09-03", "bad"], "prices": [1.0, float("nan"), None, 3.0],
                     "price_field": "Close"},
            "LBS=F": KeyError("no Close column")})
        rec(["GC=F", "LBS=F"], "2005-01-01", "2026-09-30", auto_adjust=False)
        ev = sr.build_evidence(rec, {"Gold": "GC=F", "Lumber": "LBS=F", "Wheat": "ZW=F"})
        g = ev["responses"]["Gold"]
        self.assertEqual((g["rows"], g["counts"]["ok"], g["counts"]["nan"], g["counts"]["null"]), (4, 2, 1, 1))
        self.assertEqual(g["prices"], [1.0, "NaN", None, 3.0])
        self.assertEqual(g["dates"], ["2026-09-01", "2026-09-02", "2026-09-03", "bad"])      # valid date strings stay plain
        self.assertEqual((g["first_valid"], g["last_valid"]), ("2026-09-01", "2026-09-01"))
        self.assertEqual(ev["responses"]["Lumber"]["kind"], "error")
        self.assertEqual(ev["responses"]["Wheat"]["kind"], "missing")
        self.assertEqual(ev["request"]["options"], {"auto_adjust": False})
        self.assertEqual(ev["request"]["provider_calls"], 1)
        json.dumps(ev, allow_nan=False)


class TestDiffProfile(unittest.TestCase):
    def test_exact_counts_added_removed_and_statistics(self):
        old = {"2026-09-01": 100.0, "2026-09-02": 100.0, "2026-09-03": 0.0, "2026-09-04": 100.0}
        new = {"2026-09-02": 100.0, "2026-09-03": 5.0, "2026-09-04": 102.5, "2026-09-07": 1.0}
        d = sr.diff_profile(old, new)
        self.assertEqual((d["shared_dates"], d["changed_exact"]), (3, 2))
        self.assertEqual(d["removed_dates"], {"count": 1, "first": "2026-09-01", "last": "2026-09-01"})
        self.assertEqual(d["added_dates"], {"count": 1, "first": "2026-09-07", "last": "2026-09-07"})
        self.assertEqual(d["abs_change"], {"median": 3.75, "max": 5.0})
        self.assertEqual(d["rel_change"]["n"], 1)                                 # old == 0 excluded
        self.assertEqual(d["rel_change"]["excluded_zero_denominator"], 1)
        self.assertAlmostEqual(d["rel_change"]["max"], 0.025)
        self.assertEqual(d["largest"][0]["date"], "2026-09-03")
        self.assertEqual(d["by_year"]["2026"]["changed"], 2)

    def test_tolerance_buckets_separate_representation_noise_from_cent_changes(self):
        old = {"2026-09-01": 10.0, "2026-09-02": 10.0, "2026-09-03": 10.0}
        new = {"2026-09-01": 10.0 + 1e-12, "2026-09-02": 10.004, "2026-09-03": 10.01}
        b = sr.diff_profile(old, new)["buckets_abs_change"]
        self.assertEqual(list(b.values()), [1, 1, 1])
        self.assertEqual(sr.diff_profile(old, new)["changed_exact"], 3)           # exact comparison counts all three

    def test_identical_and_disjoint_maps(self):
        same = sr.diff_profile({"2026-09-01": 1.0}, {"2026-09-01": 1.0})
        self.assertEqual((same["changed_exact"], same["abs_change"]["median"]), (0, None))
        disjoint = sr.diff_profile({"2026-09-01": 1.0}, {"2026-09-02": 1.0})
        self.assertEqual((disjoint["shared_dates"], disjoint["added_dates"]["count"], disjoint["removed_dates"]["count"]), (0, 1, 1))

    def test_step_segments_describe_pattern_without_naming_a_cause(self):
        dates = ["2026-09-0%d" % i for i in range(1, 8)]
        old = {d: 100.0 for d in dates}
        new = dict(old)
        new[dates[1]] = new[dates[2]] = 101.0           # +1 for two dates
        new[dates[4]] = 102.0                           # +2 for one date
        s = sr.step_segments(old, new)
        self.assertEqual((s["segments"], s["unchanged_runs_between"], s["distinct_cent_rounded_differences"]), (2, 3, 2))
        self.assertEqual(s["most_common_differences"][0], {"diff": 1.0, "dates": 2})

    def test_series_map_skips_and_counts_invalid_records(self):
        m, skip = sr.series_map({"labels": ["2026-09-01", "2026-09-01", "bad", "2026-09-02", "2026-09-03"],
                                 "prices": [1.0, 2.0, 3.0, None, "str:5"]})
        self.assertEqual(m, {"2026-09-01": 1.0})
        self.assertEqual(skip, {"invalid_date": 1, "invalid_price": 2, "duplicate_date": 1})


class TestReportPipeline(unittest.TestCase):
    def test_compare_sources_over_fake_staged_run(self):
        with tempfile.TemporaryDirectory() as root:
            dates = ["2026-09-%02d" % d for d in (1, 2, 3, 4, 7, 8)]
            prod = {"Gold": {"labels": dates[:4], "prices": [100.0, 101.0, 102.0, 103.0]},
                    "Lumber": {"labels": ["2026-09-03"], "prices": [380.6]}}
            backup = {"Gold": {"labels": dates[:4], "prices": [100.0, 101.0, 101.0, 103.0]},
                      "Lumber": {"labels": dates, "prices": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]}}
            # The historical baseline is an explicit path: no fixed folder name is assumed anywhere.
            baseline_rel = os.path.join("history", "commodities_baseline.json")
            os.makedirs(os.path.join(root, "history"))
            os.makedirs(os.path.join(root, "staging_stage2c1_t"))
            stage = os.path.join(root, "staging_stage2c1_t")
            for path, doc in ((os.path.join(root, "commodities_data.json"), prod),
                              (os.path.join(root, baseline_rel), backup),
                              (os.path.join(stage, "commodities_data.json"), prod)):
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(doc, fh)
            def digest(n):
                with open(os.path.join(root, n), "rb") as fh:
                    return hashlib.sha256(fh.read()).hexdigest()
            before = {n: digest(n) for n in ("commodities_data.json", baseline_rel)}
            rec = sr.RecordingDownloader(lambda s, a, b, **o: {
                "GC=F": {"dates": dates[:5], "prices": [100.0, 101.0, 102.0, 103.0, 104.0], "price_field": "Close"},
                "LBS=F": {"dates": ["2026-09-03"], "prices": [380.6], "price_field": "Close"}})
            cmap = {"Gold": "GC=F", "Lumber": "LBS=F"}
            result = ct.run_refresh(rec, output_dir=stage, clock=lambda: NOW, commodity_map=cmap, dependencies={},
                                    log=lambda *_: None, download_options=dict(sr.EXPERIMENT_OPTIONS))
            self.assertEqual(result["exit_status"], 0)               # Gold extended; Lumber candidate equals the saved single record
            ev = sr.build_evidence(rec, cmap)
            sr.write_json_strict(os.path.join(stage, sr.EVIDENCE_FILE), ev)
            report = sr.compare_sources(root, stage, baseline_rel)
            md = sr.render_markdown(report)
            self.assertIn(os.path.join(root, baseline_rel), md)                        # report names the baseline actually used
            self.assertNotIn("_pre_refresh", md)
            g, l = report["instruments"]["Gold"], report["instruments"]["Lumber"]
            self.assertEqual(g["staged_status"], "refreshed")
            self.assertEqual(g["production_vs_backup"]["changed_exact"], 1)         # 102 vs 101 on 09-03
            self.assertEqual(g["provider_vs_production"]["added_dates"]["count"], 1)
            self.assertEqual(l["backup"]["records"], 6)
            self.assertEqual(l["production"]["records"], 1)
            self.assertEqual(l["production_vs_backup"]["changed_exact"], 1)         # 380.6 vs 3.0 on the shared date
            self.assertEqual(l["provider_usable"]["records"], 1)
            self.assertIn("| Gold |", md)
            self.assertEqual(report["request"]["options"], {"auto_adjust": False, "price_field": "Close"})
            json.dumps(report, allow_nan=False)
            self.assertEqual(l["staged_status"], "refreshed")
            after = {n: digest(n) for n in before}
            self.assertEqual(before, after)                                          # comparison inputs untouched

    def test_compare_refuses_when_an_input_is_missing(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "staging_stage2c1_t"))
            with self.assertRaises(FileNotFoundError):
                sr.compare_sources(root, os.path.join(root, "staging_stage2c1_t"))

    def _staged_root(self, root, baseline_doc, baseline_path):
        """Minimal project root: production, staged dataset, evidence and sidecar, plus a baseline at an arbitrary path."""
        dates = ["2026-09-01", "2026-09-02"]
        prod = {"Gold": {"labels": dates, "prices": [100.0, 101.0]}}
        stage = os.path.join(root, "staging_stage2c1_t")
        os.makedirs(stage)
        os.makedirs(os.path.dirname(baseline_path), exist_ok=True)
        for path, doc in ((os.path.join(root, "commodities_data.json"), prod), (os.path.join(stage, "commodities_data.json"), prod),
                          (baseline_path, baseline_doc)):
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(doc, fh)
        rec = sr.RecordingDownloader(lambda s, a, b, **o: {"GC=F": {"dates": dates, "prices": [100.0, 101.0], "price_field": "Close"}})
        cmap = {"Gold": "GC=F"}
        ct.run_refresh(rec, output_dir=stage, clock=lambda: NOW, commodity_map=cmap, dependencies={},
                       log=lambda *_: None, download_options=dict(sr.EXPERIMENT_OPTIONS))
        sr.write_json_strict(os.path.join(stage, sr.EVIDENCE_FILE), sr.build_evidence(rec, cmap))
        return stage

    def test_baseline_can_be_an_absolute_path_outside_the_project_root(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as elsewhere:
            baseline = os.path.join(elsewhere, "old", "commodities.json")
            self._staged_root(root, {"Gold": {"labels": ["2026-09-01", "2026-09-02"], "prices": [99.0, 101.0]}}, baseline)
            report = sr.compare(root, "staging_stage2c1_t", baseline)
            self.assertEqual(report["paths"]["backup"], baseline)
            self.assertEqual(report["instruments"]["Gold"]["production_vs_backup"]["changed_exact"], 1)     # 2026-09-01: baseline 99.0 vs production 100.0
            with open(os.path.join(root, "staging_stage2c1_t", sr.REPORT_MD), encoding="utf-8") as fh:
                self.assertIn(baseline, fh.read())

    def test_missing_baseline_is_reported_with_its_path_and_default_is_the_retained_evidence_file(self):
        self.assertEqual(sr.BACKUP_DATASET, os.path.join("evidence", "commodities_data_pre_refresh_20260916.json"))
        self.assertNotIn("_pre_refresh_2026", os.path.dirname(sr.BACKUP_DATASET))
        with tempfile.TemporaryDirectory() as root:
            missing = os.path.join(root, "nowhere", "commodities.json")
            self._staged_root(root, {"Gold": {"labels": ["2026-09-01"], "prices": [1.0]}}, os.path.join(root, "real_baseline.json"))
            with self.assertRaises(FileNotFoundError) as cm:
                sr.compare_sources(root, os.path.join(root, "staging_stage2c1_t"), missing)
            self.assertIn(missing, str(cm.exception))

    def test_cli_compare_accepts_baseline_and_default(self):
        with mock.patch.object(sr, "compare") as cmp_, mock.patch("os.getcwd", return_value="ROOT"):
            self.assertEqual(sr.main(["compare", "--staging", "staging_stage2c1_t", "--baseline", "some/file.json"]), 0)
            cmp_.assert_called_with("ROOT", "staging_stage2c1_t", "some/file.json")
            self.assertEqual(sr.main(["compare", "--staging", "staging_stage2c1_t"]), 0)
            cmp_.assert_called_with("ROOT", "staging_stage2c1_t", None)

    def test_import_has_no_side_effects_and_experiment_definition_is_explicit(self):
        self.assertEqual(sr.EXPERIMENT_OPTIONS, {"auto_adjust": False, "price_field": "Close"})
        self.assertNotIn("yfinance", sys.modules)


if __name__ == "__main__":
    unittest.main(verbosity=1)
