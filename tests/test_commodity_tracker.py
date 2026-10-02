"""
Offline tests for commodity_tracker.py (Stage 2B: collector failure safety).

Run from the project root:   py tests/test_commodity_tracker.py

* Calls the PRODUCTION functions with fake downloaders; no provider request is made
  and yfinance is never imported (the only provider function is not called).
* Every write happens inside a temporary directory. The production datasets are only
  hashed (read-only) to prove they are untouched.
* Tests of the pandas adapter are reported as skipped ("NOT RUN") if pandas is missing.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import commodity_tracker as ct  # noqa: E402

UTC = timezone.utc
NOW = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)
LATER = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
SMALL = {"Gold": "GC=F", "Lumber": "LBS=F"}
DEPS = {"python": "test", "yfinance": "test", "pandas": "test", "numpy": "test"}
PROD = os.path.join(ROOT, "commodities_data.json")


def sha(b):
    return hashlib.sha256(b).hexdigest()


def weekdays(start, n):
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


D = weekdays(date(2026, 9, 1), 12)          # 12 weekdays in September 2026 (all before NOW)


def resp(dates, prices, field="Close"):
    return {"dates": list(dates), "prices": list(prices), "price_field": field}


def ser(dates, prices):
    return {"labels": list(dates), "prices": list(prices)}


class Fake:
    """Fake downloader; records calls."""
    def __init__(self, responses=None, raises=None):
        self.responses, self.raises, self.calls = responses, raises, []

    def __call__(self, symbols, start, end):
        self.calls.append((list(symbols), start, end))
        if self.raises:
            raise self.raises
        return self.responses


class Base(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.tmp = self._td.name
        self.ds = os.path.join(self.tmp, ct.DATASET_FILE)
        self.sc = os.path.join(self.tmp, ct.SIDECAR_FILE)

    def tearDown(self):
        self._td.cleanup()

    def put(self, doc):
        with open(self.ds, "wb") as fh:
            fh.write(json.dumps(doc, indent=2).encode("utf-8"))
        return self.read_bytes()

    def put_raw(self, raw):
        with open(self.ds, "wb") as fh:
            fh.write(raw)

    def read_bytes(self):
        with open(self.ds, "rb") as fh:
            return fh.read()

    def doc(self):
        return ct.strict_loads(self.read_bytes())

    def sidecar(self):
        with open(self.sc, "rb") as fh:
            return ct.strict_loads(fh.read())

    def run_(self, downloader, cmap=SMALL, io=None, now=NOW):
        return ct.run_refresh(downloader, output_dir=self.tmp, clock=lambda: now, io=io,
                              commodity_map=cmap, dependencies=DEPS, log=lambda *_: None)

    def leftovers(self):
        return sorted(n for n in os.listdir(self.tmp) if n not in (ct.DATASET_FILE, ct.SIDECAR_FILE))


class T01ValidRefresh(Base):
    def test_valid_successful_refresh_writes_dataset_and_consistent_sidecar(self):
        self.put({"Gold": ser(D[:5], [100, 101, 102, 103, 104]), "Lumber": ser(D[:5], [10, 11, 12, 13, 14])})
        fake = Fake({"GC=F": resp(D[:7], [100, 101, 102, 103, 104, 105, 106], "Adj Close"),
                     "LBS=F": resp(D[:6], [10, 11, 12, 13, 14, 15])})
        r = self.run_(fake)
        self.assertEqual((r["exit_status"], r["outcome"], r["dataset_replaced"]), (0, "success", True))
        doc = self.doc()
        self.assertEqual(sorted(doc), ["Gold", "Lumber"])
        for v in doc.values():                                    # frontend schema unchanged
            self.assertEqual(sorted(v), ["labels", "prices"])
        self.assertEqual(len(doc["Gold"]["labels"]), 7)
        self.assertEqual(fake.calls, [(["GC=F", "LBS=F"], ct.START_DATE, "2026-09-30")])
        side = self.sidecar()
        self.assertEqual(side["dataset_sha256"], sha(self.read_bytes()))
        self.assertEqual(ct.verify_consistency(self.ds, self.sc)["status"], "consistent")
        self.assertEqual(side["instruments"]["Gold"]["price_field"], "Adj Close")
        self.assertEqual(side["instruments"]["Gold"]["last_successful_refresh_utc"], NOW.isoformat())
        self.assertEqual(self.leftovers(), [])                    # no temp files left behind

    def test_sidecar_records_available_facts_and_marks_history_unknown(self):
        fake = Fake({"GC=F": resp(D, range(100, 112)), "LBS=F": resp(D, range(10, 22))})
        self.run_(fake)
        s = self.sidecar()
        self.assertEqual(s["schema"], ct.SIDECAR_SCHEMA)
        self.assertIn("yfinance", s["provider"])
        self.assertEqual(s["instruments"]["Gold"]["symbol"], "GC=F")
        self.assertEqual((s["request"]["start"], s["request"]["end"]), ("2005-01-01", "2026-09-30"))
        self.assertIn("not passed", s["request"]["auto_adjust"])
        self.assertEqual(s["dependencies"], DEPS)
        self.assertTrue(s["historical_provenance"].startswith("unknown"))
        self.assertIn("not one", s["atomicity_note"])
        self.assertEqual(s["last_attempt"]["outcome"], "success")

    def test_default_dependency_lookup_uses_metadata_only(self):
        deps = ct.dependency_versions()
        self.assertEqual(sorted(deps), ["numpy", "pandas", "python", "yfinance"])
        self.assertNotIn("yfinance", sys.modules)


class T02ExceptionAndTimeout(Base):
    def _fail_all(self, exc):
        before = self.put({"Gold": ser(D[:5], [1, 2, 3, 4, 5]), "Lumber": ser(D[:5], [1, 2, 3, 4, 5])})
        r = self.run_(Fake(raises=exc))
        self.assertEqual((r["exit_status"], r["outcome"], r["dataset_replaced"]), (1, "failed", False))
        self.assertEqual(self.read_bytes(), before)
        for rec in r["instruments"].values():
            self.assertEqual(rec["status"], "retained")
            self.assertTrue(any("download failed" in x for x in rec["reasons"]))
        return r

    def test_exception_keeps_prior_data_byte_identical(self):
        self._fail_all(RuntimeError("provider exploded"))

    def test_timeout_keeps_prior_data_byte_identical(self):
        r = self._fail_all(TimeoutError("timed out"))
        self.assertIn("TimeoutError", r["instruments"]["Gold"]["reasons"][0])

    def test_per_instrument_provider_error_is_isolated(self):
        self.put({"Gold": ser(D[:5], [1, 2, 3, 4, 5]), "Lumber": ser(D[:5], [1, 2, 3, 4, 5])})
        r = self.run_(Fake({"GC=F": resp(D[:6], [1, 2, 3, 4, 5, 6]), "LBS=F": ValueError("bad symbol")}))
        self.assertEqual(r["exit_status"], 2)
        self.assertEqual(r["instruments"]["Lumber"]["status"], "retained")
        self.assertTrue(any("provider error: ValueError" in x for x in r["instruments"]["Lumber"]["reasons"]))

    def test_downloader_returning_non_mapping_fails_all(self):
        before = self.put({"Gold": ser(D[:3], [1, 2, 3])})
        r = self.run_(Fake(["not", "a", "mapping"]), cmap={"Gold": "GC=F"})
        self.assertEqual(r["exit_status"], 1)
        self.assertEqual(self.read_bytes(), before)


class T03EmptyAndMissing(Base):
    def setUp(self):
        super().setUp()
        self.before = self.put({"Gold": ser(D[:5], [1, 2, 3, 4, 5])})

    def _single(self, response, expect_reason):
        r = self.run_(Fake({"GC=F": response}), cmap={"Gold": "GC=F"})
        self.assertEqual(r["exit_status"], 1)
        self.assertEqual(self.read_bytes(), self.before)
        rec = r["instruments"]["Gold"]
        self.assertEqual(rec["status"], "retained")
        self.assertTrue(any(expect_reason in x for x in rec["reasons"]), rec["reasons"])

    def test_empty_response_rows(self):
        self._single(resp([], []), "empty response")

    def test_symbol_absent_from_response(self):
        self._single(None, "no response for symbol")
        r = self.run_(Fake({}), cmap={"Gold": "GC=F"})
        self.assertTrue(any("no response for symbol GC=F" in x for x in r["instruments"]["Gold"]["reasons"]))

    def test_missing_required_columns(self):
        self._single({"dates": D[:3]}, "missing required column(s): prices")
        self._single({"prices": [1, 2, 3]}, "missing required column(s): dates")
        self._single({}, "missing required column(s): dates, prices")

    def test_unsupported_shapes(self):
        self._single("a string", "not a mapping")
        self._single({"dates": "2026-09-01", "prices": "1"}, "must be lists")
        self._single({"dates": D[:3], "prices": [1, 2]}, "unequal lengths")

    def test_all_rows_unusable(self):
        self._single(resp(D[:3], [None, float("nan"), "x"]), "no usable observations")


class T05InvalidValues(Base):
    def test_null_nan_inf_and_non_numeric_removed_counted_and_disclosed(self):
        self.put({"Gold": ser(D[:3], [1, 2, 3])})
        bad = [None, float("nan"), float("inf"), float("-inf"), "12.5", True]
        resp_ = resp(D[:3] + D[3:9], [1, 2, 3] + bad)
        r = self.run_(Fake({"GC=F": resp_}), cmap={"Gold": "GC=F"})
        self.assertEqual(r["exit_status"], 0)
        att = r["instruments"]["Gold"]["attempt"]
        self.assertEqual(att["removed_rows"], {"null": 1, "nan": 1, "infinite": 2, "non_numeric": 2})
        self.assertEqual((att["rows_received"], att["removed_total"], att["usable_observations"]), (9, 6, 3))
        self.assertTrue(any("removed for invalid prices" in w for w in att["warnings"]))
        raw = self.read_bytes()
        self.assertNotIn(b"NaN", raw)
        self.assertNotIn(b"Infinity", raw)
        self.assertEqual(self.doc()["Gold"]["labels"], D[:3])
        self.assertEqual(self.sidecar()["instruments"]["Gold"]["attempt"]["removed_rows"]["infinite"], 2)

    def test_removal_that_drops_a_saved_date_is_rejected_after_coverage_validation(self):
        before = self.put({"Gold": ser(D[:5], [1, 2, 3, 4, 5])})
        prices = [1, 2, float("nan"), 4, 5, 6]            # D[2] is a saved date whose price became NaN
        r = self.run_(Fake({"GC=F": resp(D[:6], prices)}), cmap={"Gold": "GC=F"})
        self.assertEqual(r["exit_status"], 1)
        self.assertEqual(self.read_bytes(), before)
        self.assertTrue(any("drops 1 previously stored date" in x for x in r["instruments"]["Gold"]["reasons"]))

    def test_invalid_price_on_new_date_is_removed_and_series_still_accepted(self):
        self.put({"Gold": ser(D[:5], [1, 2, 3, 4, 5])})
        r = self.run_(Fake({"GC=F": resp(D[:7], [1, 2, 3, 4, 5, 6, None])}), cmap={"Gold": "GC=F"})
        self.assertEqual(r["exit_status"], 0)
        self.assertEqual(self.doc()["Gold"]["labels"], D[:6])             # nothing filled for D[6]


class T06NegativePrices(Base):
    def test_valid_negative_and_zero_prices_are_accepted(self):
        wti = {"WTI Crude": "CL=F"}
        self.put({"WTI Crude": ser(D[:3], [20.0, 19.0, 18.0])})
        r = self.run_(Fake({"CL=F": resp(D[:5], [20.0, 19.0, 18.0, -37.63, 0.0])}), cmap=wti)
        self.assertEqual(r["exit_status"], 0)
        self.assertEqual(self.doc()["WTI Crude"]["prices"], [20.0, 19.0, 18.0, -37.63, 0.0])
        att = r["instruments"]["WTI Crude"]["attempt"]
        self.assertEqual((att["negative_prices"], att["zero_prices"]), (1, 1))
        self.assertEqual(att["removed_total"], 0)

    def test_validate_candidate_does_not_reject_negative(self):
        v = ct.validate_candidate(resp(D[:2], [-5, -1]), date(2026, 9, 30))
        self.assertTrue(v["ok"])
        self.assertEqual(v["prices"], [-5, -1])


class T07Dates(Base):
    AS_OF = date(2026, 9, 30)

    def _reasons(self, dates, prices):
        v = ct.validate_candidate(resp(dates, prices), self.AS_OF)
        self.assertFalse(v["ok"])
        return " | ".join(v["reasons"])

    def test_invalid_dates_rejected(self):
        self.assertIn("1 invalid date", self._reasons(["2026-02-30", "2026-09-01"], [1, 2]))
        self.assertIn("invalid date", self._reasons(["2026-9-1", "2026-09-02"], [1, 2]))
        self.assertIn("invalid date", self._reasons([20260901, "2026-09-02"], [1, 2]))
        self.assertIn("invalid date", self._reasons([None, "2026-09-02"], [1, 2]))

    def test_duplicate_dates_rejected_even_if_prices_are_equal(self):
        self.assertIn("1 duplicate date", self._reasons(["2026-09-01", "2026-09-01", "2026-09-02"], [1, 1, 2]))

    def test_future_dates_rejected_relative_to_supplied_clock(self):
        self.assertIn("after as-of 2026-09-30", self._reasons(["2026-09-29", "2026-10-01"], [1, 2]))
        ok = ct.validate_candidate(resp(["2026-09-29", "2026-09-30"], [1, 2]), self.AS_OF)
        self.assertTrue(ok["ok"])                                         # as-of date itself is allowed

    def test_unsorted_dates_are_sorted_with_prices_kept_paired(self):
        v = ct.validate_candidate(resp(["2026-09-03", "2026-09-01", "2026-09-02"], [3.0, 1.0, 2.0]), self.AS_OF)
        self.assertTrue(v["ok"])
        self.assertEqual((v["labels"], v["prices"]), (["2026-09-01", "2026-09-02", "2026-09-03"], [1.0, 2.0, 3.0]))
        self.assertTrue(v["stats"]["reordered"])

    def test_rejected_dates_leave_dataset_untouched(self):
        before = self.put({"Gold": ser(D[:3], [1, 2, 3])})
        r = self.run_(Fake({"GC=F": resp(["2026-09-01", "2026-09-01", "2026-09-02"], [1, 1, 2])}), cmap={"Gold": "GC=F"})
        self.assertEqual((r["exit_status"], self.read_bytes()), (1, before))

    def test_source_lists_are_not_mutated(self):
        dates, prices = ["2026-09-03", "2026-09-01"], [3.0, 1.0]
        ct.validate_candidate(resp(dates, prices), self.AS_OF)
        self.assertEqual((dates, prices), (["2026-09-03", "2026-09-01"], [3.0, 1.0]))


class T08ShortenedHistory(Base):
    def test_lumber_like_many_records_to_one_is_rejected_and_prior_retained(self):
        dates = weekdays(date(2005, 1, 3), 4597)
        prior = ser(dates, [round(100 + i * 0.01, 2) for i in range(len(dates))])
        before = self.put({"Lumber": prior, "Gold": ser(D[:3], [1, 2, 3])})
        r = self.run_(Fake({"LBS=F": resp(["2023-04-10"], [380.6]), "GC=F": resp(D[:4], [1, 2, 3, 4])}))
        rec = r["instruments"]["Lumber"]
        self.assertEqual(rec["status"], "retained")
        dropped = len(dates) - (1 if "2023-04-10" in dates else 0)
        self.assertTrue(any("drops %d previously stored date(s)" % dropped in x for x in rec["reasons"]), rec["reasons"])
        self.assertTrue(any("starts later" in x for x in rec["reasons"]))
        self.assertEqual(self.doc()["Lumber"], prior)                      # prior history intact
        self.assertEqual(rec["coverage"]["records"], 4597)
        self.assertEqual(r["exit_status"], 2)                              # Gold refreshed, Lumber retained

    def test_starts_later_and_ends_earlier_each_reported(self):
        prev = {d: 1.0 for d in D[:6]}
        c1 = ct.compare_with_previous(prev, D[1:6], [1.0] * 5)
        self.assertFalse(c1["ok"])
        self.assertTrue(any("starts later" in x for x in c1["reasons"]))
        c2 = ct.compare_with_previous(prev, D[0:5], [1.0] * 5)
        self.assertTrue(any("ends earlier" in x for x in c2["reasons"]))

    def test_candidate_with_extra_dates_inside_history_is_accepted(self):
        prev = {D[0]: 1.0, D[2]: 3.0}
        c = ct.compare_with_previous(prev, D[0:4], [1.0, 2.0, 3.0, 4.0])
        self.assertTrue(c["ok"])
        self.assertEqual(c["revisions"]["revised_dates"], 0)


class T09PartialSuccess(Base):
    def test_one_instrument_fails_other_succeeds_and_retained_refresh_time_is_not_rewritten(self):
        self.put({"Gold": ser(D[:5], [1, 2, 3, 4, 5]), "Lumber": ser(D[:5], [9, 8, 7, 6, 5])})
        first = self.run_(Fake({"GC=F": resp(D[:5], [1, 2, 3, 4, 5]), "LBS=F": resp(D[:5], [9, 8, 7, 6, 5])}), now=NOW)
        self.assertEqual(first["exit_status"], 0)
        r = self.run_(Fake({"GC=F": resp(D[:6], [1, 2, 3, 4, 5, 6]), "LBS=F": RuntimeError("boom")}), now=LATER)
        self.assertEqual((r["exit_status"], r["outcome"]), (2, "partial"))
        self.assertEqual(r["instruments"]["Gold"]["status"], "refreshed")
        self.assertEqual(r["instruments"]["Lumber"]["status"], "retained")
        s = self.sidecar()["instruments"]
        self.assertEqual(s["Gold"]["last_successful_refresh_utc"], LATER.isoformat())
        self.assertEqual(s["Lumber"]["last_successful_refresh_utc"], NOW.isoformat())      # NOT described as newly refreshed
        self.assertTrue(s["Lumber"]["last_successful_refresh_known"])
        self.assertEqual(self.doc()["Lumber"], ser(D[:5], [9, 8, 7, 6, 5]))
        self.assertEqual(ct.verify_consistency(self.ds, self.sc)["status"], "consistent")

    def test_retained_refresh_time_is_unknown_without_a_matching_sidecar(self):
        self.put({"Gold": ser(D[:5], [1, 2, 3, 4, 5]), "Lumber": ser(D[:5], [9, 8, 7, 6, 5])})
        r = self.run_(Fake({"GC=F": resp(D[:5], [1, 2, 3, 4, 5]), "LBS=F": RuntimeError("boom")}))
        rec = r["instruments"]["Lumber"]
        self.assertEqual((rec["last_successful_refresh_utc"], rec["last_successful_refresh_known"]), (None, False))

    def test_stale_sidecar_hash_mismatch_does_not_lend_refresh_times(self):
        self.put({"Gold": ser(D[:5], [1, 2, 3, 4, 5]), "Lumber": ser(D[:5], [9, 8, 7, 6, 5])})
        self.run_(Fake({"GC=F": resp(D[:5], [1, 2, 3, 4, 5]), "LBS=F": resp(D[:5], [9, 8, 7, 6, 5])}))
        self.put({"Gold": ser(D[:5], [1, 2, 3, 4, 5]), "Lumber": ser(D[:5], [9, 8, 7, 6, 6])})    # dataset edited outside
        r = self.run_(Fake({"GC=F": resp(D[:5], [1, 2, 3, 4, 5]), "LBS=F": RuntimeError("boom")}), now=LATER)
        self.assertFalse(r["instruments"]["Lumber"]["last_successful_refresh_known"])


class T10AllFail(Base):
    def test_all_rejected_leaves_dataset_byte_identical_and_reports_failure(self):
        before = self.put({"Gold": ser(D[:5], [1, 2, 3, 4, 5]), "Lumber": ser(D[:5], [1, 2, 3, 4, 5])})
        r = self.run_(Fake({"GC=F": resp([], []), "LBS=F": resp(["2026-09-01"], [1.0])}))
        self.assertEqual((r["exit_status"], r["outcome"], r["dataset_replaced"]), (1, "failed", False))
        self.assertEqual(self.read_bytes(), before)
        side = self.sidecar()
        self.assertEqual(side["last_attempt"]["outcome"], "failed")
        self.assertEqual(side["dataset_sha256"], sha(before))               # sidecar still describes the unchanged file
        self.assertEqual(side["last_attempt"]["counts"]["refreshed"], 0)
        self.assertEqual(ct.verify_consistency(self.ds, self.sc)["status"], "consistent")
        self.assertEqual(self.leftovers(), [])


class T11NoUsablePrevious(Base):
    def test_missing_dataset_one_succeeds_one_fails(self):
        r = self.run_(Fake({"GC=F": resp(D[:5], [1, 2, 3, 4, 5]), "LBS=F": RuntimeError("down")}))
        self.assertEqual(r["exit_status"], 2)
        self.assertEqual(sorted(self.doc()), ["Gold"])
        rec = r["instruments"]["Lumber"]
        self.assertEqual(rec["status"], "unavailable")
        self.assertIn("no usable previous series", rec["reasons"])
        self.assertNotIn("Lumber", self.doc())                              # nothing fabricated

    def test_missing_dataset_all_fail_creates_no_dataset(self):
        r = self.run_(Fake(raises=RuntimeError("down")))
        self.assertEqual(r["exit_status"], 1)
        self.assertFalse(os.path.exists(self.ds))
        self.assertIsNone(self.sidecar()["dataset_sha256"])

    def test_unusable_saved_series_is_carried_over_unchanged_when_download_fails(self):
        broken = {"labels": D[:3], "prices": [1, None, 3]}                  # a null price: not a usable saved series
        before = self.put({"Gold": broken, "Lumber": ser(D[:3], [1, 2, 3])})
        r = self.run_(Fake({"GC=F": RuntimeError("down"), "LBS=F": resp(D[:4], [1, 2, 3, 4])}))
        self.assertEqual(r["instruments"]["Gold"]["status"], "unavailable")
        self.assertTrue(any("carried over unchanged" in x for x in r["instruments"]["Gold"]["reasons"]))
        self.assertEqual(self.doc()["Gold"], broken)                        # not destroyed, not repaired

    def test_valid_candidate_may_replace_an_unusable_saved_series(self):
        self.put({"Gold": {"labels": D[:3], "prices": [1, None, 3]}})
        r = self.run_(Fake({"GC=F": resp(D[:3], [1, 2, 3])}), cmap={"Gold": "GC=F"})
        self.assertEqual(r["exit_status"], 0)
        self.assertEqual(self.doc()["Gold"], ser(D[:3], [1, 2, 3]))
        self.assertTrue(any("saved series was unusable" in x for x in r["instruments"]["Gold"]["reasons"]))

    def test_saved_instruments_outside_the_map_are_preserved(self):
        self.put({"Gold": ser(D[:3], [1, 2, 3]), "Extra": ser(D[:3], [5, 6, 7])})
        r = self.run_(Fake({"GC=F": resp(D[:4], [1, 2, 3, 4]), "LBS=F": resp(D[:4], [1, 2, 3, 4])}))
        self.assertEqual(self.doc()["Extra"], ser(D[:3], [5, 6, 7]))
        self.assertEqual(r["instruments"]["Extra"]["status"], "not_requested_retained")


class T12CorruptPrevious(Base):
    CASES = {
        "truncated json": b'{"Gold": {"labels": ["2026-09-01"',
        "NaN token": b'{"Gold": {"labels": ["2026-09-01"], "prices": [NaN]}}',
        "Infinity token": b'{"Gold": {"labels": ["2026-09-01"], "prices": [Infinity]}}',
        "duplicate key": b'{"Gold": {"labels": [], "prices": []}, "Gold": {"labels": [], "prices": []}}',
        "list top level": b'[1, 2, 3]',
        "empty file": b'',
        "not utf-8": b'\xff\xfe\x00\x01',
    }

    def test_unreadable_or_invalid_dataset_is_never_overwritten_and_nothing_is_requested(self):
        for label, raw in self.CASES.items():
            with self.subTest(label):
                self.put_raw(raw)
                fake = Fake({"GC=F": resp(D[:3], [1, 2, 3]), "LBS=F": resp(D[:3], [1, 2, 3])})
                r = self.run_(fake)
                self.assertEqual((r["exit_status"], r["outcome"]), (3, "refused"))
                self.assertEqual(fake.calls, [])                              # no request made
                self.assertEqual(self.read_bytes(), raw)
                self.assertFalse(os.path.exists(self.sc))
                self.assertIsNotNone(r["dataset_error"])


class T13WriteFailures(Base):
    def setUp(self):
        super().setUp()
        self.before = self.put({"Gold": ser(D[:5], [1, 2, 3, 4, 5])})
        self.fake = Fake({"GC=F": resp(D[:6], [1, 2, 3, 4, 5, 6])})

    def _expect_preserved(self, r):
        self.assertEqual((r["exit_status"], r["outcome"], r["dataset_replaced"]), (5, "write_failed", False))
        self.assertEqual(self.read_bytes(), self.before)
        self.assertEqual(self.leftovers(), [])
        self.assertIsNotNone(r["dataset_error"])

    def test_nan_and_infinity_cannot_be_serialised(self):
        for bad in (float("nan"), float("inf"), float("-inf")):
            with self.assertRaises(ValueError):
                ct.serialize_document({"Gold": {"labels": ["2026-09-01"], "prices": [bad]}})

    def test_serialization_failure_preserves_dataset(self):
        real = ct.serialize_document
        calls = {"n": 0}

        def flaky(doc):
            calls["n"] += 1
            if calls["n"] == 1:
                raise ValueError("Out of range float values are not JSON compliant")
            return real(doc)
        with mock.patch.object(ct, "serialize_document", flaky):
            r = self.run_(self.fake, cmap={"Gold": "GC=F"})
        self._expect_preserved(r)
        self.assertIn("serialization failed", r["dataset_error"])

    def test_temporary_file_creation_failure_preserves_dataset(self):
        def no_temp(**kw):
            raise OSError("disk full")
        r = self.run_(self.fake, cmap={"Gold": "GC=F"}, io=ct.FileIO(temp_factory=no_temp))
        self._expect_preserved(r)

    def test_temporary_write_failure_removes_temp_and_preserves_dataset(self):
        def bad_fsync(fd):
            raise OSError("write error")
        r = self.run_(self.fake, cmap={"Gold": "GC=F"}, io=ct.FileIO(fsync=bad_fsync))
        self._expect_preserved(r)

    def test_replacement_failure_removes_temp_and_preserves_dataset(self):
        def bad_replace(src, dst):
            raise PermissionError("destination is locked")
        r = self.run_(self.fake, cmap={"Gold": "GC=F"}, io=ct.FileIO(replace=bad_replace))
        self._expect_preserved(r)
        self.assertIn("PermissionError", r["dataset_error"])

    def test_write_failure_still_records_attempt_in_sidecar_describing_unchanged_dataset(self):
        def bad_replace(src, dst):
            if dst.endswith(ct.DATASET_FILE):
                raise PermissionError("locked")
            os.replace(src, dst)
        r = self.run_(self.fake, cmap={"Gold": "GC=F"}, io=ct.FileIO(replace=bad_replace))
        self.assertEqual(r["exit_status"], 5)
        side = self.sidecar()
        self.assertEqual(side["dataset_sha256"], sha(self.before))
        self.assertFalse(side["dataset_replaced_by_this_attempt"])
        self.assertEqual(side["last_attempt"]["outcome"], "write_failed")

    def test_verification_failure_preserves_dataset(self):
        with mock.patch.object(ct, "_verify_dataset_bytes", side_effect=ct.WriteError("re-read differs")):
            r = self.run_(self.fake, cmap={"Gold": "GC=F"})
        self._expect_preserved(r)


class FailSidecarIO(ct.FileIO):
    def write_atomic(self, path, payload, verify=None):
        if path.endswith(ct.SIDECAR_FILE):
            raise ct.WriteError("sidecar disk error")
        return super().write_atomic(path, payload, verify)


class T14SidecarConsistency(Base):
    def test_sidecar_failure_after_dataset_write_is_visible_and_hash_mismatch_detectable(self):
        self.put({"Gold": ser(D[:5], [1, 2, 3, 4, 5])})
        first = self.run_(Fake({"GC=F": resp(D[:5], [1, 2, 3, 4, 5])}), cmap={"Gold": "GC=F"})
        self.assertEqual(first["exit_status"], 0)
        old_hash = self.sidecar()["dataset_sha256"]
        r = self.run_(Fake({"GC=F": resp(D[:6], [1, 2, 3, 4, 5, 6])}), cmap={"Gold": "GC=F"}, io=FailSidecarIO())
        self.assertEqual(r["exit_status"], 4)
        self.assertTrue(r["dataset_replaced"])
        self.assertFalse(r["sidecar_written"])
        self.assertIn("sidecar disk error", r["sidecar_error"])
        self.assertEqual(self.sidecar()["dataset_sha256"], old_hash)           # stale sidecar left in place
        v = ct.verify_consistency(self.ds, self.sc)
        self.assertEqual(v["status"], "dataset_hash_mismatch")
        again = self.run_(Fake({"GC=F": resp(D[:6], [1, 2, 3, 4, 5, 6])}), cmap={"Gold": "GC=F"})   # recovery run
        self.assertEqual(again["exit_status"], 0)
        self.assertEqual(ct.verify_consistency(self.ds, self.sc)["status"], "consistent")

    def test_missing_sidecar_and_tampered_dataset_are_detected(self):
        self.put({"Gold": ser(D[:3], [1, 2, 3])})
        self.assertEqual(ct.verify_consistency(self.ds, self.sc)["status"], "sidecar_missing_or_invalid")
        self.run_(Fake({"GC=F": resp(D[:4], [1, 2, 3, 4])}), cmap={"Gold": "GC=F"})
        self.assertEqual(ct.verify_consistency(self.ds, self.sc)["status"], "consistent")
        with open(self.ds, "ab") as fh:
            fh.write(b" ")
        self.assertEqual(ct.verify_consistency(self.ds, self.sc)["status"], "dataset_hash_mismatch")
        os.remove(self.ds)
        self.assertEqual(ct.verify_consistency(self.ds, self.sc)["status"], "dataset_missing")

    def test_sidecar_failure_on_a_failed_refresh_does_not_mask_the_failure_status(self):
        before = self.put({"Gold": ser(D[:3], [1, 2, 3])})
        r = self.run_(Fake(raises=RuntimeError("down")), cmap={"Gold": "GC=F"}, io=FailSidecarIO())
        self.assertEqual(r["exit_status"], 1)
        self.assertIn("sidecar disk error", r["sidecar_error"])
        self.assertEqual(self.read_bytes(), before)

    def test_cli_verify_exit_codes_and_no_download(self):
        self.put({"Gold": ser(D[:3], [1, 2, 3])})
        out = []
        self.assertEqual(ct.main(["--verify", "--output-dir", self.tmp], log=out.append), 6)
        self.run_(Fake({"GC=F": resp(D[:4], [1, 2, 3, 4])}), cmap={"Gold": "GC=F"})
        self.assertEqual(ct.main(["--verify", "--output-dir", self.tmp], log=out.append), 0)


class T15ImportSafety(unittest.TestCase):
    def test_import_has_no_network_write_or_provider_import_side_effects(self):
        code = (
            "import socket, sys\n"
            "def _blocked(*a, **k): raise RuntimeError('network blocked')\n"
            "socket.socket = _blocked; socket.create_connection = _blocked; socket.getaddrinfo = _blocked\n"
            "import commodity_tracker as ct\n"
            "assert 'yfinance' not in sys.modules and 'pandas' not in sys.modules, 'provider/pandas imported'\n"
            "assert ct.__name__ == 'commodity_tracker'\n"
            "print('import-ok')\n")
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, PYTHONPATH=ROOT, PYTHONDONTWRITEBYTECODE="1")
            p = subprocess.run([sys.executable, "-B", "-c", code], cwd=tmp, env=env,
                               capture_output=True, text=True, timeout=60)
            self.assertEqual((p.returncode, p.stdout.strip()), (0, "import-ok"), p.stderr)
            self.assertEqual(os.listdir(tmp), [])                              # nothing written

    def test_module_level_import_in_this_process_did_not_load_provider(self):
        self.assertNotIn("yfinance", sys.modules)


class T16Revisions(Base):
    def test_revisions_on_shared_dates_are_counted_and_disclosed_not_merged_silently(self):
        self.put({"Gold": ser(D[:5], [100.0] * 5)})
        cand = [100.0, 101.0, 97.5, 100.0, 100.5, 100.0]
        r = self.run_(Fake({"GC=F": resp(D[:6], cand)}), cmap={"Gold": "GC=F"})
        self.assertEqual(r["exit_status"], 0)
        rv = r["instruments"]["Gold"]["revisions"]
        self.assertEqual((rv["shared_dates"], rv["revised_dates"]), (5, 3))
        self.assertEqual((rv["first_revised"], rv["last_revised"]), (D[1], D[4]))
        self.assertAlmostEqual(rv["max_abs_change"], 2.5)
        self.assertAlmostEqual(rv["max_rel_change"], 0.025)
        self.assertEqual(rv["cause"], "not inferred")
        self.assertEqual(self.doc()["Gold"]["prices"], cand)                   # whole accepted candidate, disclosed
        self.assertEqual(self.sidecar()["instruments"]["Gold"]["revisions"]["revised_dates"], 3)

    def test_unrevised_overlap_reports_zero(self):
        self.put({"Gold": ser(D[:3], [1.0, 2.0, 3.0])})
        r = self.run_(Fake({"GC=F": resp(D[:4], [1.0, 2.0, 3.0, 4.0])}), cmap={"Gold": "GC=F"})
        self.assertEqual(r["instruments"]["Gold"]["revisions"]["revised_dates"], 0)


class TAdapterAndCli(Base):
    def test_main_end_to_end_with_default_symbol_map_and_fake_downloader(self):
        responses = {sym: resp(D, [10.0 + i for i in range(len(D))]) for sym in ct.COMMODITY_MAP.values()}
        rc = ct.main(["--output-dir", self.tmp], downloader=Fake(responses), clock=lambda: NOW, log=lambda *_: None)
        self.assertEqual(rc, 0)
        self.assertEqual(list(self.doc()), list(ct.COMMODITY_MAP))
        self.assertEqual(ct.COMMODITY_MAP["Lumber"], "LBS=F")                  # symbols unchanged
        self.assertEqual(ct.verify_consistency(self.ds, self.sc)["status"], "consistent")

    def test_frame_to_responses_with_pandas_frame(self):
        try:
            import pandas as pd
        except ImportError:
            self.skipTest("NOT RUN: pandas unavailable")
        idx = pd.to_datetime(["2026-09-01", "2026-09-02", "2026-09-03"])
        cols = pd.MultiIndex.from_tuples([("Close", "GC=F"), ("Close", "LBS=F"), ("Adj Close", "ZZ=F"), ("Close", "ZZ=F")])
        frame = pd.DataFrame([[1.0, float("nan"), 5.0, 6.0], [2.0, float("nan"), 7.0, 8.0], [3.0, 4.0, 9.0, 10.0]],
                             index=idx, columns=cols)
        out = ct.frame_to_responses(frame, ["GC=F", "LBS=F", "ZZ=F", "MISSING"])
        self.assertEqual(out["GC=F"]["dates"], ["2026-09-01", "2026-09-02", "2026-09-03"])
        self.assertEqual(out["GC=F"]["price_field"], "Close")
        self.assertEqual(out["ZZ=F"]["price_field"], "Adj Close")             # 'Adj Close' preferred when present
        self.assertEqual(out["ZZ=F"]["prices"], [5.0, 7.0, 9.0])
        self.assertIsInstance(out["MISSING"], Exception)
        # NaN rows pass through so validation counts them (they are not silently dropped)
        v = ct.validate_candidate(out["LBS=F"], date(2026, 9, 30))
        self.assertTrue(v["ok"])
        self.assertEqual((v["stats"]["removed_rows"]["nan"], v["labels"]), (2, ["2026-09-03"]))
        self.assertEqual(ct.frame_to_responses(pd.DataFrame(), ["GC=F"]), {})
        self.assertEqual(ct.frame_to_responses(None, ["GC=F"]), {})


class FakeKw(Fake):
    """Downloader that accepts and records explicit keyword options."""
    def __call__(self, symbols, start, end, **options):
        self.options = options
        return super().__call__(symbols, start, end)


class TExplicitOptions(Base):
    """Stage 2C1: explicit auto_adjust / price field reach the downloader and the provider call."""
    OPTS = {"auto_adjust": False, "price_field": "Close"}

    def test_options_reach_downloader_and_are_recorded_in_sidecar(self):
        fake = FakeKw({"GC=F": resp(D[:3], [1, 2, 3])})
        r = ct.run_refresh(fake, output_dir=self.tmp, clock=lambda: NOW, commodity_map={"Gold": "GC=F"},
                           dependencies=DEPS, log=lambda *_: None, download_options=dict(self.OPTS))
        self.assertEqual(r["exit_status"], 0)
        self.assertEqual(fake.options, self.OPTS)
        req = self.sidecar()["request"]
        self.assertEqual(req["auto_adjust"], "explicit: False")
        self.assertEqual(req["price_field_rule"], "explicit: 'Close'")
        self.assertEqual(req["download_options"], self.OPTS)

    def test_default_call_is_unchanged_and_passes_no_extra_arguments(self):
        fake = FakeKw({"GC=F": resp(D[:3], [1, 2, 3])})
        self.run_(fake, cmap={"Gold": "GC=F"})
        self.assertEqual(fake.options, {})
        self.assertIn("not passed", self.sidecar()["request"]["auto_adjust"])
        legacy = Fake({"GC=F": resp(D[:3], [1, 2, 3])})           # legacy 3-argument downloader still works
        self.assertEqual(self.run_(legacy, cmap={"Gold": "GC=F"})["exit_status"], 0)

    def test_cli_flags_build_the_options(self):
        fake = FakeKw({sym: resp(D[:3], [1, 2, 3]) for sym in ct.COMMODITY_MAP.values()})
        ct.main(["--output-dir", self.tmp, "--auto-adjust", "false", "--price-field", "Close"],
                downloader=fake, clock=lambda: NOW, log=lambda *_: None)
        self.assertEqual(fake.options, self.OPTS)
        fake2 = FakeKw({sym: resp(D[:3], [1, 2, 3]) for sym in ct.COMMODITY_MAP.values()})
        ct.main(["--output-dir", self.tmp], downloader=fake2, clock=lambda: NOW, log=lambda *_: None)
        self.assertEqual(fake2.options, {})

    def test_explicit_price_field_selects_only_that_column(self):
        try:
            import pandas as pd
        except ImportError:
            self.skipTest("NOT RUN: pandas unavailable")
        idx = pd.to_datetime(["2026-09-01", "2026-09-02"])
        cols = pd.MultiIndex.from_tuples([("Close", "A=F"), ("Adj Close", "A=F"), ("Adj Close", "B=F")])
        frame = pd.DataFrame([[1.0, 9.0, 8.0], [2.0, 9.5, 8.5]], index=idx, columns=cols)
        out = ct.frame_to_responses(frame, ["A=F", "B=F"], price_field="Close")
        self.assertEqual((out["A=F"]["price_field"], out["A=F"]["prices"]), ("Close", [1.0, 2.0]))
        self.assertIsInstance(out["B=F"], KeyError)                       # no silent fallback to 'Adj Close'
        legacy = ct.frame_to_responses(frame, ["A=F"])
        self.assertEqual(legacy["A=F"]["price_field"], "Adj Close")       # legacy rule unchanged

    def test_auto_adjust_parameter_reaches_the_provider_call(self):
        try:
            import pandas as pd
        except ImportError:
            self.skipTest("NOT RUN: pandas unavailable")
        import types
        seen = {}

        def fake_download(tickers, start=None, end=None, auto_adjust=True, timeout=10):
            seen.update(tickers=tickers, start=start, end=end, auto_adjust=auto_adjust, timeout=timeout)
            cols = pd.MultiIndex.from_tuples([("Close", "A=F"), ("Adj Close", "A=F")])
            return pd.DataFrame([[1.0, 2.0]], index=pd.to_datetime(["2026-09-01"]), columns=cols)
        stub = types.ModuleType("yfinance")
        stub.download = fake_download
        with mock.patch.dict(sys.modules, {"yfinance": stub}):
            out = ct.yfinance_downloader(["A=F"], "2005-01-01", "2026-09-30", auto_adjust=False, price_field="Close")
            self.assertIs(seen["auto_adjust"], False)
            self.assertEqual((seen["tickers"], seen["start"], seen["end"]), (["A=F"], "2005-01-01", "2026-09-30"))
            self.assertEqual(seen["timeout"], ct.DOWNLOAD_TIMEOUT_S)
            self.assertEqual((out["A=F"]["price_field"], out["A=F"]["prices"]), ("Close", [1.0]))
            seen.clear()
            ct.yfinance_downloader(["A=F"], "2005-01-01", "2026-09-30")
            self.assertIs(seen["auto_adjust"], True)                       # not passed -> stub/library default
        self.assertNotIn("yfinance", sys.modules)


class TProductionUntouched(unittest.TestCase):
    # Stage 2C2 (2026-09-30): the reviewed 13-instrument update was promoted, so the pinned production
    # hash changed from ACA04DCD... (Stage 2B/2C1 production, no sidecar) to the promoted dataset below,
    # and a hash-linked production sidecar now exists. Any later production change must update this pin.
    PROMOTED_SHA256 = "5c255bb2f469a9c91c2f79db8fccfc3c2ae1fece9de0697cd0d26aa18c602da3"

    def test_production_dataset_is_the_promoted_one_with_a_consistent_sidecar(self):
        with open(PROD, "rb") as fh:
            self.assertEqual(sha(fh.read()).lower(), self.PROMOTED_SHA256)
        verdict = ct.verify_consistency(PROD, os.path.join(ROOT, ct.SIDECAR_FILE))     # read-only
        self.assertEqual(verdict["status"], "consistent", verdict)
        self.assertFalse(os.path.exists(os.path.join(ROOT, "commodities_data_candidate.json")))

    def test_existing_production_file_passes_the_collector_loader(self):
        status, data, raw, why = ct.load_previous(PROD)               # read-only
        self.assertEqual((status, why), ("ok", None))
        usable = {k: ct.check_previous_series(v)[1] for k, v in data.items()}
        self.assertTrue(all(v is None for v in usable.values()), usable)


if __name__ == "__main__":
    unittest.main(verbosity=1)
