"""
Offline tests for sector_candidate_compare.py and the sector_event_coverage.js harness.
Temporary directories and tiny synthetic fixtures only: no provider, no network, no production writes.
Run from the project root:  py tests/test_sector_candidate_compare.py
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import sector_candidate_compare as cc   # noqa: E402

NODE = shutil.which("node")


def pts(pairs):
    return [{"x": d, "y": p} for d, p in pairs]


def sha(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)


class T1DateAlignment(unittest.TestCase):
    def test_comparison_is_by_date_not_position(self):
        prod = pts([("2020-01-02", 10), ("2020-01-03", 11), ("2020-01-06", 12)])
        cand = pts([("2020-01-03", 11), ("2020-01-06", 12), ("2020-01-07", 13)])   # same length, shifted calendar
        r = cc.compare_series(prod, cand)
        self.assertEqual(r["dates"]["shared"], 2)
        self.assertEqual(r["dates"]["added"]["count"], 1)
        self.assertEqual(r["dates"]["added"]["first"], "2020-01-07")
        self.assertEqual(r["dates"]["removed"]["count"], 1)
        self.assertEqual(r["revisions"]["exact_count"], 0)       # index alignment would have reported 3 revisions

    def test_unsorted_input_is_paired_by_date(self):
        prod = pts([("2020-01-06", 12), ("2020-01-02", 10), ("2020-01-03", 11)])
        cand = pts([("2020-01-02", 10), ("2020-01-03", 11), ("2020-01-06", 12)])
        r = cc.compare_series(prod, cand)
        self.assertEqual((r["dates"]["shared"], r["revisions"]["exact_count"]), (3, 0))
        self.assertEqual(r["production"]["first"], "2020-01-02")


class T2AddedRemovedLeadingInternal(unittest.TestCase):
    def test_leading_internal_and_trailing_removals_are_separated(self):
        prod = pts([("2020-01-02", 5), ("2020-01-03", 5), ("2020-01-06", 5), ("2020-01-07", 6),
                    ("2020-01-08", 7), ("2020-01-09", 8), ("2020-01-10", 9)])
        cand = pts([("2020-01-06", 5.5), ("2020-01-07", 6), ("2020-01-09", 8)])   # starts later, lacks 01-08, ends before 01-10
        r = cc.compare_series(prod, cand)
        rem = r["dates"]["removed"]
        self.assertEqual((rem["count"], rem["before_candidate_start"], rem["internal"], rem["after_candidate_end"]), (4, 2, 1, 1))
        self.assertEqual(rem["internal_sample"], ["2020-01-08"])
        self.assertEqual(r["production_leading_identical_run"]["length"], 3)
        self.assertEqual(r["production_leading_identical_run"]["dates_absent_from_candidate"], 2)

    def test_added_dates_before_inside_after_production_range(self):
        prod = pts([("2020-01-03", 1), ("2020-01-07", 2)])
        cand = pts([("2020-01-02", 1), ("2020-01-03", 1), ("2020-01-06", 1.5), ("2020-01-07", 2), ("2020-01-08", 3)])
        a = cc.compare_series(prod, cand)["dates"]["added"]
        self.assertEqual((a["count"], a["before_production_first"], a["internal"], a["after_production_last"]), (3, 1, 1, 1))


class T3Revisions(unittest.TestCase):
    def setUp(self):
        self.prod = pts([("2020-01-02", 100), ("2020-01-03", 100), ("2020-01-06", 100), ("2020-01-07", 100)])
        self.cand = pts([("2020-01-02", 110), ("2020-01-03", 100.005), ("2020-01-06", 100), ("2020-01-07", 90)])

    def test_exact_and_tolerance_counts_are_disclosed_separately(self):
        v = cc.compare_series(self.prod, self.cand)["revisions"]
        self.assertEqual(v["exact_count"], 3)          # 110, 100.005, 90
        self.assertEqual(v["tolerance_count"], 2)      # 100.005 is within the 0.01 tolerance
        self.assertEqual(v["unchanged_count"], 1)
        self.assertEqual((v["candidate_higher"], v["candidate_lower"]), (2, 1))

    def test_statistics_and_denominator(self):
        v = cc.compare_series(self.prod, self.cand)["revisions"]
        self.assertEqual(v["max_abs"]["value"], 10.0)
        self.assertEqual(v["max_abs"]["date"], "2020-01-02")
        self.assertAlmostEqual(v["median_abs"], 10.0)  # median of 10, 0.005, 10
        self.assertAlmostEqual(v["max_rel_pct"]["value"], 10.0)   # (110-100)/100: denominator is the PRODUCTION price
        self.assertEqual((v["first_revised"], v["last_revised"]), ("2020-01-02", "2020-01-07"))
        self.assertEqual(cc.compare_series(self.prod, self.cand)["tolerance"]["relative_denominator"], "production price")

    def test_year_pattern_present(self):
        v = cc.compare_series(self.prod, self.cand)["revisions"]["by_year"]
        self.assertEqual(v["2020"]["shared"], 4)
        self.assertEqual(v["2020"]["revised"], 3)


class T4RetainedLegacy(unittest.TestCase):
    def test_retained_instrument_shows_no_change_and_keeps_its_label(self):
        legacy = pts([("2020-01-02", 10), ("2020-01-03", 10), ("2020-01-06", 11)])
        sidecar = {"instruments": {"XLC": {"status": "retained", "provenance": "retained_legacy_unverified",
                                           "reasons": ["download failed"], "review_required": False}}}
        res = cc.compare_datasets({"XLC": legacy}, {"XLC": list(legacy)}, sidecar)
        r = res["tickers"]["XLC"]
        self.assertEqual(r["status"]["status"], "retained")
        self.assertEqual(r["status"]["provenance"], "retained_legacy_unverified")
        self.assertEqual((r["dates"]["added"]["count"], r["dates"]["removed"]["count"], r["revisions"]["exact_count"]), (0, 0, 0))
        self.assertNotEqual(r["status"]["status"], "refreshed")

    def test_missing_sidecar_is_reported_as_unknown_not_refreshed(self):
        s = cc.candidate_status(None, "XLK")
        self.assertTrue(s["status"].startswith("unknown"))
        self.assertTrue(cc.candidate_status({"instruments": {}}, "XLK")["status"].startswith("unknown"))

    def test_ticker_absent_from_candidate_is_all_removed(self):
        res = cc.compare_datasets({"XLK": pts([("2020-01-02", 1), ("2020-01-03", 2)])}, {})
        r = res["tickers"]["XLK"]
        self.assertEqual(r["dates"]["removed"]["count"], 2)
        self.assertFalse(r["in_candidate"])


class T5InputsUnchanged(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.prod = os.path.join(self.tmp, "prod.json")
        self.cand = os.path.join(self.tmp, "cand.json")
        write_json(self.prod, {"XLK": pts([("2020-01-02", 1), ("2020-01-03", 2)])})
        write_json(self.cand, {"XLK": pts([("2020-01-02", 1.5), ("2020-01-03", 2), ("2020-01-06", 3)])})
        self.out = os.path.join(self.tmp, "out", "cmp.json")
        os.makedirs(os.path.dirname(self.out))

    def test_inputs_are_byte_identical_after_a_run(self):
        before = (sha(self.prod), sha(self.cand))
        rc = cc.main(["--production", self.prod, "--candidate", self.cand, "--out-json", self.out,
                      "--out-md", os.path.join(self.tmp, "out", "t.md")])
        self.assertEqual(rc, 0)
        self.assertEqual((sha(self.prod), sha(self.cand)), before)
        with open(self.out, encoding="utf-8") as fh:
            self.assertTrue(json.load(fh)["inputs_unchanged"])

    def test_output_path_equal_to_input_is_refused_and_input_untouched(self):
        before = sha(self.prod)
        self.assertEqual(cc.main(["--production", self.prod, "--candidate", self.cand, "--out-json", self.prod]), 3)
        self.assertEqual(sha(self.prod), before)

    def test_output_inside_application_folder_is_refused(self):
        app = os.path.join(self.tmp, "app")
        os.makedirs(app)
        open(os.path.join(app, "index.html"), "w").close()
        rc = cc.main(["--production", self.prod, "--candidate", self.cand, "--out-json", os.path.join(app, "x.json")])
        self.assertEqual(rc, 3)
        self.assertFalse(os.path.exists(os.path.join(app, "x.json")))

    def test_strict_json_loader_rejects_nan_and_duplicate_keys(self):
        bad = os.path.join(self.tmp, "bad.json")
        with open(bad, "w") as fh:
            fh.write('{"XLK": [{"x": "2020-01-02", "y": NaN}]}')
        with self.assertRaises(ValueError):
            cc.read_json_strict(bad)
        with open(bad, "w") as fh:
            fh.write('{"XLK": [], "XLK": []}')
        with self.assertRaises(ValueError):
            cc.read_json_strict(bad)

    def test_unusable_points_are_excluded_and_counted_not_priced(self):
        m, prob = cc.points_to_map([{"x": "2020-01-02", "y": None}, {"x": "2020-01-03", "y": True},
                                    {"x": "2020-01-06", "y": "7"}, {"x": "2020-13-01", "y": 1},
                                    {"x": "2020-01-07", "y": 5}, {"x": "2020-01-07", "y": 6}, {"x": "2020-01-08", "y": 8}])
        self.assertEqual(m, {"2020-01-08": 8.0})
        self.assertEqual(prob["unusable_price"], 3)
        self.assertEqual(prob["invalid_date"], ["2020-13-01"])
        self.assertEqual(prob["duplicate_date"], ["2020-01-07"])


class T6Diagnostics(unittest.TestCase):
    def test_adjustment_diagnostic_distinguishes_proportional_series(self):
        dates = ["2020-01-%02d" % d for d in range(1, 21)]
        close = {d: 100.0 + i for i, d in enumerate(dates)}
        adj = {d: close[d] * (0.90 + 0.005 * i) for i, d in enumerate(dates)}          # ratio drifts: NOT constant vs close
        k = 1.01
        prod = pts([(d, round(adj[d] * k, 2)) for d in dates])
        res = cc.adjustment_diagnostic(prod, close, adj)
        self.assertEqual(res["vs_candidate_Adj_Close"]["within_residual_tolerance"], len(dates))
        self.assertLess(res["vs_candidate_Adj_Close"]["ratio_spread_pct"], 0.1)
        self.assertGreater(res["vs_candidate_Close"]["ratio_spread_pct"], 5)
        self.assertIn("does not establish", res["note"])

    def test_repeat_screen_flags_real_moves_not_rounding_level_moves(self):
        prod = pts([("2020-01-02", 8.0), ("2020-01-03", 9.0), ("2020-01-06", 9.0), ("2020-01-07", 9.0), ("2020-01-08", 10.0)])
        cand = pts([("2020-01-02", 10.0), ("2020-01-03", 12.0), ("2020-01-06", 12.4),      # +3.3%: prod repeat is suspicious
                    ("2020-01-07", 12.401), ("2020-01-08", 14.0)])                          # +0.008%: rounding-level
        r = cc.compare_series(prod, cand)["repeat_screen"]
        self.assertEqual(r["production_repeats_where_candidate_differs"], 1)
        self.assertEqual(r["repeats_with_small_candidate_move_treated_as_rounding"], 1)
        self.assertEqual(r["sample"][0]["dates"], ["2020-01-03", "2020-01-06"])

    def test_raw_frame_parser_and_evidence(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        path = os.path.join(tmp, "f.csv")
        with open(path, "w", newline="") as fh:
            fh.write("Price,Adj Close,Adj Close,Close,Close\nTicker,AAA,BBB,AAA,BBB\nDate,,,,\n"
                     "2020-01-02,1.5,,2.0,\n2020-01-03,1.6,3.0,2.1,3.2\n")
        fr = cc.read_raw_frame(path)
        self.assertIsNone(fr["Close"]["BBB"]["2020-01-02"])
        ev = cc.raw_evidence(fr, "BBB")
        self.assertEqual((ev["rows_in_frame"], ev["close_nan"], ev["close_nan_leading"], ev["first_valid_close"]),
                         (2, 1, 1, "2020-01-03"))


class T7EventCoverageDiff(unittest.TestCase):
    def _row(self, dataset, event, ticker, row, horizons=None, baseline=None):
        return {"dataset": dataset, "event": event, "eventDate": "2020-02-03", "ticker": ticker, "row": row,
                "baseline": baseline, "horizons": horizons, "reason": None}

    def _h(self, avail, end=None, pct=None):
        return {"available": avail, "endpointDate": end, "pct": pct, "reason": None if avail else "history ends earlier"}

    def test_state_classification_and_overlap_deltas(self):
        allh = lambda **kw: {h: kw.get(h, self._h(True, "2020-02-05", 1.0)) for h in cc.HORIZONS}
        cov = {"tickers": ["XLK", "XLRE"], "events": [{"name": "E", "date": "2020-02-03"}], "max_event_baseline_age_days": 7,
               "rows": [
                   self._row("production", "E", "XLK", "shown", allh(**{"T+22": self._h(False)}), {"date": "2020-01-31"}),
                   self._row("candidate", "E", "XLK", "shown", allh(**{"T+22": self._h(True, "2020-03-04", 2.0), "T+252": self._h(True, "2021-01-29", 3.5)}), {"date": "2020-01-31"}),
                   self._row("production", "E", "XLRE", "shown", allh(), {"date": "2020-01-31"}),
                   self._row("candidate", "E", "XLRE", "omitted"),
               ]}
        out = cc.compare_event_coverage(cov)
        s = out["summary"]
        self.assertEqual(s["row_states"], {"shown->shown": 1, "shown->omitted": 1})
        self.assertEqual(s["horizon_states"]["T+22"]["unavailable_to_available"], 1)
        self.assertEqual(s["horizon_states"]["T+22"]["available_to_unavailable"], 1)
        self.assertEqual(s["horizon_states"]["T+1"]["available_both"], 1)
        self.assertEqual(s["horizon_states"]["T+1"]["available_to_unavailable"], 1)
        self.assertEqual(out["row_changes"][0]["ticker"], "XLRE")
        self.assertEqual(s["by_ticker"]["XLRE"]["rows_prod"], 1)
        self.assertEqual(s["by_ticker"]["XLRE"]["rows_cand"], 0)

    def test_same_endpoint_value_change_is_measured(self):
        cov = {"tickers": ["XLK"], "events": [{"name": "E", "date": "2020-02-03"}], "rows": [
            self._row("production", "E", "XLK", "shown", {h: self._h(True, "2020-02-05", 1.0) for h in cc.HORIZONS}, {"date": "d"}),
            self._row("candidate", "E", "XLK", "shown", {h: self._h(True, "2020-02-05", 3.5) for h in cc.HORIZONS}, {"date": "d"})]}
        out = cc.compare_event_coverage(cov)
        self.assertEqual(out["summary"]["overlap_pct_point_changes"]["T+5"]["max_abs_pp"], 2.5)
        self.assertTrue(all(c["same_endpoint"] for c in out["cell_changes"]))


@unittest.skipUnless(NODE, "node not on PATH")
class T8ProductionHarness(unittest.TestCase):
    """The harness runs the REAL app.js. Expected values below are worked out by hand from the fixture."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        # 60 weekdays from Monday 2020-01-06; price = 100 + index
        import datetime
        d, labels = datetime.date(2020, 1, 6), []
        while len(labels) < 60:
            if d.weekday() < 5:
                labels.append(d.isoformat())
            d += datetime.timedelta(days=1)
        self.labels = labels
        self.xlk = [{"x": x, "y": 100 + i} for i, x in enumerate(labels)]
        self.xlre = [{"x": x, "y": 100 + i} for i, x in enumerate(labels) if x >= "2020-02-10"]    # starts after the event
        self.paths = {}
        for name, doc in (("a", {"XLK": self.xlk, "XLRE": self.xlre}), ("b", {"XLK": self.xlk})):
            self.paths[name] = os.path.join(self.tmp, name + ".json")
            write_json(self.paths[name], doc)
        self.events = os.path.join(self.tmp, "events.json")
        write_json(self.events, [{"name": "Ev", "date": "2020-02-03"}])
        self.out = os.path.join(self.tmp, "cov.json")

    def run_harness(self):
        p = subprocess.run([NODE, os.path.join(ROOT, "sector_event_coverage.js"), "--events", self.events,
                            "--dataset", "one=" + self.paths["a"], "--dataset", "two=" + self.paths["b"], "--out", self.out],
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(p.returncode, 0, p.stderr)
        with open(self.out, encoding="utf-8") as fh:
            return json.load(fh)

    def row(self, cov, dataset, ticker):
        return next(r for r in cov["rows"] if r["dataset"] == dataset and r["ticker"] == ticker)

    def test_baseline_endpoints_and_unavailable_reason_come_from_production_code(self):
        cov = self.run_harness()
        r = self.row(cov, "one", "XLK")
        self.assertEqual(r["row"], "shown")
        self.assertEqual(r["baseline"]["date"], "2020-01-31")        # last observation before Monday 2020-02-03
        self.assertEqual(r["baseline"]["price"], 119)      # weekday index 19 (Friday 2020-01-31)
        self.assertEqual(r["horizons"]["T+1"]["endpointDate"], "2020-02-03")
        self.assertEqual(r["horizons"]["T+5"]["endpointDate"], "2020-02-07")
        self.assertEqual(r["horizons"]["T+22"]["endpointDate"], "2020-03-03")   # weekday index 41
        self.assertAlmostEqual(r["horizons"]["T+1"]["pct"], (120 / 119 - 1) * 100)
        self.assertEqual(r["horizons"]["T+1"]["displayed"], "0.84%")
        self.assertTrue(r["horizons"]["T+1"]["consistent_with_display"])
        t252 = r["horizons"]["T+252"]
        self.assertFalse(t252["available"])
        self.assertIn("history ends earlier", t252["reason"])
        self.assertIn("40 observation(s) after the baseline", t252["reason"])

    def test_series_beginning_after_the_event_is_omitted_and_absent_ticker_is_reported(self):
        cov = self.run_harness()
        self.assertEqual(self.row(cov, "one", "XLRE")["row"], "omitted")
        self.assertIn("begins on or after", self.row(cov, "one", "XLRE")["reason"])
        self.assertEqual(self.row(cov, "two", "XLRE")["row"], "omitted")       # ticker absent from that dataset
        self.assertEqual(len(cov["rows"]), 2 * 11 * 1)

    def test_harness_leaves_inputs_and_app_unchanged(self):
        app_before = sha(os.path.join(ROOT, "app.js"))
        before = [sha(self.paths["a"]), sha(self.paths["b"]), sha(self.events)]
        self.run_harness()
        self.assertEqual([sha(self.paths["a"]), sha(self.paths["b"]), sha(self.events)], before)
        self.assertEqual(sha(os.path.join(ROOT, "app.js")), app_before)

    def test_harness_result_feeds_the_comparison(self):
        cov = self.run_harness()
        cov_cmp = {"rows": [dict(r, dataset={"one": "production", "two": "candidate"}[r["dataset"]]) for r in cov["rows"]],
                   "events": cov["events"], "tickers": cov["tickers"], "max_event_baseline_age_days": cov["max_event_baseline_age_days"]}
        out = cc.compare_event_coverage(cov_cmp)
        self.assertEqual(out["summary"]["row_states"].get("omitted->omitted"), 9 + 1)    # 9 absent tickers + XLRE
        self.assertEqual(out["summary"]["row_states"].get("shown->shown"), 1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
