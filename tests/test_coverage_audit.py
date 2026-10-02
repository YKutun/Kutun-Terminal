"""
Focused offline tests for coverage_audit.py (Stage 2A).

Run from the project root:   py tests/test_coverage_audit.py
Uses only the standard library, small in-memory/temporary fixtures, no network,
no collector import. The production datasets are never opened by these tests.
"""
import hashlib
import io
import json
import math
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from datetime import date

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import coverage_audit as ca  # noqa: E402

AS_OF = date(2026, 9, 30)


def series(pairs, as_of=AS_OF, **kw):
    return ca.audit_series("test", "X", pairs, as_of, **kw)


class GapTests(unittest.TestCase):
    def test_exactly_seven_days_is_not_a_gap_eight_is(self):
        s = series([("2026-01-01", 1), ("2026-01-08", 2), ("2026-01-16", 3)])
        self.assertEqual(s["calendar_gaps_over_7d"], 1)
        self.assertEqual(s["largest_gap"], {"days": 8, "from": "2026-01-08", "to": "2026-01-16"})

    def test_largest_gap_and_count(self):
        s = series([("2026-01-01", 1), ("2026-01-12", 1), ("2026-01-13", 1), ("2026-03-01", 1)])
        self.assertEqual(s["calendar_gaps_over_7d"], 2)
        self.assertEqual(s["largest_gap"]["days"], 47)
        self.assertEqual((s["largest_gap"]["from"], s["largest_gap"]["to"]), ("2026-01-13", "2026-03-01"))
        self.assertIn("INTERNAL_CALENDAR_GAPS", s["flags"])

    def test_gap_measured_between_usable_observations_across_an_invalid_price(self):
        # the null record is not usable, so the gap spans it
        s = series([("2026-01-01", 1), ("2026-01-05", None), ("2026-01-20", 1)])
        self.assertEqual(s["calendar_gaps_over_7d"], 1)
        self.assertEqual(s["largest_gap"]["days"], 19)


class SingleAndEmptyTests(unittest.TestCase):
    def test_single_observation_series_and_windows(self):
        s = series([("2023-04-10", 380.6)])
        self.assertEqual(s["usable_observations"], 1)
        self.assertIn("SINGLE_OBSERVATION_SERIES", s["flags"])
        self.assertIn("STALE_ENDING_COVERAGE", s["flags"])
        self.assertEqual(s["latest_price_age_days"], (AS_OF - date(2023, 4, 10)).days)
        for tf in ("1W", "1M", "3M", "6M", "YTD", "1Y"):
            self.assertEqual(s["windows"][tf]["state"], "no_observations", tf)
            self.assertEqual(s["windows"][tf]["finite_observations"], 0)
        for tf in ("5Y", "MAX"):
            w = s["windows"][tf]
            self.assertEqual(w["state"], "single_observation", tf)
            self.assertEqual((w["first_valid"], w["last_valid"]), ("2023-04-10", "2023-04-10"))

    def test_no_usable_observations(self):
        s = series([("2026-01-01", None), ("2026-01-02", "x")])
        self.assertEqual(s["usable_observations"], 0)
        self.assertIn("NO_USABLE_OBSERVATIONS", s["flags"])
        self.assertIsNone(s["latest_finite_date"])
        self.assertIsNone(s["latest_price_age_days"])
        self.assertEqual(s["windows"]["MAX"]["state"], "no_observations")

    def test_multiple_observations_state(self):
        s = series([("2026-09-01", 1), ("2026-09-02", 2)])
        self.assertEqual(s["windows"]["1M"]["state"], "multiple_observations")
        self.assertEqual(s["windows"]["1M"]["finite_observations"], 2)


class InvalidRecordTests(unittest.TestCase):
    def test_duplicates_invalid_dates_and_sort_order(self):
        s = series([("2026-01-02", 1), ("2026-01-01", 2), ("2026-01-02", 3),
                    ("2026-02-30", 4), ("not-a-date", 5), ("2026-1-5", 6), (None, 7)])
        self.assertEqual(s["records"], 7)
        self.assertEqual(s["invalid_dates"], 4)       # Feb 30, text, non-padded, None
        self.assertEqual(s["duplicate_dates"], 1)
        self.assertEqual(s["source_sort_order"], "unsorted")
        self.assertEqual(s["usable_observations"], 2)  # duplicate date counted once
        self.assertIn("INVALID_DATES", s["flags"])
        self.assertIn("DUPLICATE_DATES", s["flags"])

    def test_sort_orders(self):
        asc = series([("2026-01-01", 1), ("2026-01-02", 1)])
        desc = series([("2026-01-02", 1), ("2026-01-01", 1)])
        self.assertEqual(asc["source_sort_order"], "ascending")
        self.assertEqual(desc["source_sort_order"], "descending")

    def test_price_kinds_counted_separately(self):
        s = series([("2026-01-01", None), ("2026-01-02", "12.5"), ("2026-01-03", True),
                    ("2026-01-04", float("nan")), ("2026-01-05", float("inf")),
                    ("2026-01-06", float("-inf")), ("2026-01-07", 5)])
        self.assertEqual(s["null_prices"], 1)
        self.assertEqual(s["non_numeric_prices"], 2)   # numeric string and bool
        self.assertEqual(s["non_finite_prices"], 3)
        self.assertEqual(s["finite_prices"], 1)
        self.assertEqual(s["usable_observations"], 1)
        self.assertIn("INVALID_PRICES", s["flags"])

    def test_zero_and_negative_are_usable_and_reported_separately(self):
        s = series([("2026-09-01", 0), ("2026-09-02", -37.63), ("2026-09-03", 10)])
        self.assertEqual(s["zero_prices"], 1)
        self.assertEqual(s["negative_prices"], 1)
        self.assertEqual(s["usable_observations"], 3)
        self.assertEqual(s["finite_prices"], 3)
        self.assertIn("ZERO_PRICES", s["flags"])
        self.assertIn("NEGATIVE_PRICES", s["flags"])
        self.assertNotIn("INVALID_PRICES", s["flags"])

    def test_future_dated_records(self):
        s = series([("2026-09-29", 1), ("2026-10-01", 2), ("2027-01-01", 3)])
        self.assertEqual(s["future_dated_records"], 2)
        self.assertIn("FUTURE_DATED", s["flags"])
        self.assertEqual(s["latest_record_date"], "2027-01-01")
        self.assertEqual(s["latest_price_age_days"], -93)    # negative age = future-dated

    def test_leap_day_is_a_real_date_non_leap_is_not(self):
        s = series([("2024-02-29", 1), ("2025-02-29", 1)])
        self.assertEqual(s["invalid_dates"], 1)
        self.assertEqual(s["usable_observations"], 1)


class LayoutTests(unittest.TestCase):
    def test_unequal_lengths_reported_and_only_pairs_used(self):
        res = ca.audit_commodities({"A": {"labels": ["2026-01-01", "2026-01-02", "2026-01-03"],
                                          "prices": [1, 2]}}, AS_OF)
        a = res[0]
        self.assertEqual(a["unequal_lengths"], [3, 2])
        self.assertIn("UNEQUAL_LENGTHS", a["flags"])
        self.assertEqual(a["records"], 2)

    def test_structure_problems(self):
        res = ca.audit_commodities({"A": {"labels": "x"}, "B": 5}, AS_OF)
        self.assertTrue(all("STRUCTURE_PROBLEM" in r["flags"] for r in res))
        res = ca.audit_sectors({"S": [{"x": "2026-01-01", "y": 1}, 7]}, AS_OF)
        self.assertIn("STRUCTURE_PROBLEM", res[0]["flags"])
        res = ca.audit_equities({"E": {"metadata": {}, "historical_prices": "N/A"}}, AS_OF)
        self.assertIn("STRUCTURE_PROBLEM", res[0]["flags"])

    def test_duplicate_json_keys_detected_in_equity_dict(self):
        raw = '{"E": {"metadata": {}, "historical_prices": {"2026-01-01": 1, "2026-01-01": 2, "2026-01-02": 3}}}'
        data = json.loads(raw, object_pairs_hook=ca._pairs_hook)
        res = ca.audit_equities(data, AS_OF)[0]
        self.assertEqual(res["duplicate_json_keys"], 1)
        self.assertIn("DUPLICATE_DATES", res["flags"])

    def test_sector_row_missing_fields(self):
        res = ca.audit_sectors({"S": [{"x": "2026-01-01"}, {"y": 3}, {"x": "2026-01-02", "y": 4}]}, AS_OF)[0]
        self.assertEqual(res["null_prices"], 1)           # row 1 has no y
        self.assertEqual(res["invalid_dates"], 1)         # row 2 has no x
        self.assertEqual(res["finite_prices"], 2)         # rows 2 and 3 have finite y
        self.assertEqual(res["usable_observations"], 1)   # only row 3 has both a valid date and a finite price


class StaleAndFlatTests(unittest.TestCase):
    def test_stale_threshold_is_more_than_30_days(self):
        fresh = series([("2026-08-31", 1)])     # exactly 30 days old
        stale = series([("2026-08-30", 1)])     # 31 days old
        self.assertNotIn("STALE_ENDING_COVERAGE", fresh["flags"])
        self.assertIn("STALE_ENDING_COVERAGE", stale["flags"])

    def test_leading_flat_run_is_reported_as_evidence_only(self):
        rows = [("2026-01-%02d" % d, 10.0) for d in range(1, 26)] + [("2026-01-26", 11.0)]
        s = series(rows)
        self.assertEqual(s["leading_flat_run"], {"length": 25, "last_date": "2026-01-25"})
        self.assertIn("LEADING_FLAT_RUN_POSSIBLE_BACKFILL", s["flags"])

    def test_annual_counts(self):
        s = series([("2025-12-31", 1), ("2026-01-02", 1), ("2026-01-05", 1)])
        self.assertEqual(s["annual_counts"], {"2025": 1, "2026": 2})


class WindowTests(unittest.TestCase):
    def test_cutoffs_with_month_end_clamping_and_leap_years(self):
        d = ca.window_cutoff
        self.assertEqual(d("1M", date(2019, 3, 31)), date(2019, 2, 28))
        self.assertEqual(d("1M", date(2020, 3, 31)), date(2020, 2, 29))
        self.assertEqual(d("1Y", date(2020, 2, 29)), date(2019, 2, 28))
        self.assertEqual(d("1W", date(2026, 3, 1)), date(2026, 2, 22))
        self.assertEqual(d("3M", date(2026, 5, 31)), date(2026, 2, 28))
        self.assertEqual(d("YTD", date(2026, 9, 30)), date(2026, 1, 1))
        self.assertEqual(d("5Y", date(2026, 9, 30)), date(2021, 9, 30))
        self.assertEqual(d("MAX", date(2026, 9, 30)), date(2005, 1, 1))
        with self.assertRaises(ValueError):
            d("2Y", AS_OF)

    def test_cutoff_date_is_inclusive_and_only_window_gaps_are_counted(self):
        s = series([("2026-08-30", 1), ("2026-08-31", 1), ("2026-09-20", 1), ("2026-09-21", 1)],
                   as_of=date(2026, 9, 30))
        w = s["windows"]["1M"]                  # cutoff 2026-08-30 included
        self.assertEqual(w["cutoff"], "2026-08-30")
        self.assertEqual(w["finite_observations"], 4)
        s2 = series([("2026-08-29", 1), ("2026-08-30", 1)], as_of=date(2026, 9, 30))
        self.assertEqual(s2["windows"]["1M"]["finite_observations"], 1)
        self.assertEqual(s2["windows"]["1M"]["state"], "single_observation")
        self.assertEqual(w["calendar_gaps_over_7d"], 1)    # 08-31 -> 09-20 inside the window


class CliAndSafetyTests(unittest.TestCase):
    def test_as_of_is_required_and_validated(self):
        err = io.StringIO()
        with redirect_stderr(err), self.assertRaises(SystemExit) as cm:
            ca.main([])
        self.assertEqual(cm.exception.code, 2)
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(ca.main(["--as-of", "2026-02-30"]), 2)

    def test_module_does_not_import_collectors_or_providers(self):
        for name in ("yfinance", "pandas", "commodity_tracker", "equity_engine", "macro_engine",
                     "finance_tracker", "urllib.request"):
            self.assertNotIn(name, sys.modules, name)

    def test_run_is_read_only_and_reproducible(self):
        with tempfile.TemporaryDirectory() as tmp:
            files = {
                "commodities_data.json": {"G": {"labels": ["2026-09-01", "2026-09-02"], "prices": [1, 2]}},
                "sector_historical.json": {"S": [{"x": "2026-09-01", "y": 1}]},
                "equity_data.json": {"E": {"metadata": {}, "historical_prices": {"2026-09-01": 5}}},
            }
            for n, obj in files.items():
                with open(os.path.join(tmp, n), "w", encoding="utf-8") as fh:
                    json.dump(obj, fh)
            def digest(n):
                with open(os.path.join(tmp, n), "rb") as fh:
                    return hashlib.sha256(fh.read()).hexdigest()

            def snap():
                return {n: (digest(n), os.path.getmtime(os.path.join(tmp, n))) for n in sorted(os.listdir(tmp))}
            before = snap()
            r1 = ca.run_audit(tmp, AS_OF)
            r2 = ca.run_audit(tmp, AS_OF)
            buf = io.StringIO()
            with redirect_stdout(buf):
                self.assertEqual(ca.main(["--root", tmp, "--as-of", "2026-09-30", "--json"]), 0)
            self.assertEqual(snap(), before)                 # nothing written, hashes and mtimes unchanged
            self.assertEqual(sorted(os.listdir(tmp)), sorted(files))
            self.assertEqual(r1, r2)
            self.assertEqual(r1["as_of"], "2026-09-30")
            self.assertEqual(json.loads(buf.getvalue())["as_of"], "2026-09-30")
            self.assertEqual([s["dataset"] for s in r1["series"]], ["commodities", "sector", "equity"])

    def test_missing_dataset_file_is_reported_not_created(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = ca.run_audit(tmp, AS_OF)
            self.assertEqual(sorted(r["missing_files"]), sorted(ca.DATASET_FILES.values()))
            self.assertEqual(os.listdir(tmp), [])

    def test_report_is_strict_json_serialisable(self):
        s = series([("2026-01-01", float("nan")), ("2026-01-02", 1)])
        json.dumps(s, allow_nan=False)
        self.assertFalse(any(isinstance(v, float) and not math.isfinite(v) for v in s.values()))


if __name__ == "__main__":
    unittest.main(verbosity=1)
