"""
Offline tests for sector_tracker.py (Stage 2D1).

Every test calls the production functions with fake downloaders and temporary directories.
No provider request is made, no production file is written (setUpModule/tearDownModule
prove the real project files are byte-identical before and after), macro_engine is never
executed. The yfinance module is stubbed where the real adapter is exercised.

Run from the project root:   py tests/test_sector_tracker.py
"""
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import commodity_tracker as ct  # noqa: E402
import sector_tracker as st  # noqa: E402

NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)          # as-of date 2026-10-02
NOW2 = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc)
D = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]
SYMS = list(st.SECTOR_SYMBOLS)
PROTECTED_REAL = ["sector_historical.json", "macro_events.json", "live_news.json", "commodities_data.json",
                  "equity_data.json", "app.js", "index.html"]
_snapshot = {}


def sha_file(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def setUpModule():
    for f in PROTECTED_REAL:
        p = os.path.join(ROOT, f)
        _snapshot[f] = sha_file(p) if os.path.exists(p) else None
    _snapshot["__sidecar_present__"] = os.path.exists(os.path.join(ROOT, st.SIDECAR_FILE))


def tearDownModule():
    now = {f: (sha_file(os.path.join(ROOT, f)) if os.path.exists(os.path.join(ROOT, f)) else None)
           for f in PROTECTED_REAL}
    now["__sidecar_present__"] = os.path.exists(os.path.join(ROOT, st.SIDECAR_FILE))
    assert now == _snapshot, "a real project file changed during the sector tracker tests"


def resp(dates, prices, field="Close"):
    return {"dates": list(dates), "prices": list(prices), "price_field": field}


def good(offset=0.0, dates=D):
    return resp(dates, [100.0 + offset + i for i in range(len(dates))])


def all_good():
    return {s: good(offset=k * 10) for k, s in enumerate(SYMS)}


class Fake:
    """Injectable downloader; records every call."""
    def __init__(self, responses=None, exc=None):
        self.responses, self.exc, self.calls = responses, exc, []

    def __call__(self, symbols, start, end, **options):
        self.calls.append({"symbols": list(symbols), "start": start, "end": end, "options": dict(options)})
        if self.exc is not None:
            raise self.exc
        return self.responses


def legacy_doc(**series):
    return {k: [{"x": d, "y": p} for d, p in v] for k, v in series.items()}


class FailOn(st.FileIO):
    """Fail the atomic write of one file (matched by name suffix)."""
    def __init__(self, suffix):
        super().__init__()
        self.suffix = suffix

    def write_atomic(self, path, payload, verify=None):
        if path.endswith(self.suffix):
            raise st.WriteError("forced failure for %s" % self.suffix)
        return super().write_atomic(path, payload, verify)


class Base(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.dir = self._td.name
        self.ds = os.path.join(self.dir, st.DATASET_FILE)
        self.sc = os.path.join(self.dir, st.SIDECAR_FILE)

    def tearDown(self):
        self._td.cleanup()

    def run_(self, downloader, clock=NOW, **kw):
        kw.setdefault("dependencies", {})
        kw.setdefault("log", lambda *_: None)
        return st.run_refresh(downloader, self.dir, clock=lambda: clock, **kw)

    def put(self, doc=None, raw=None):
        data = raw if raw is not None else json.dumps(doc, indent=4).encode()
        with open(self.ds, "wb") as fh:
            fh.write(data)
        return data

    def dataset(self):
        with open(self.ds, "rb") as fh:
            return ct.strict_loads(fh.read())

    def sidecar(self):
        with open(self.sc, "rb") as fh:
            return ct.strict_loads(fh.read())

    def raw(self, path=None):
        with open(path or self.ds, "rb") as fh:
            return fh.read()

    def no_temp_files(self):
        self.assertEqual([f for f in os.listdir(self.dir) if f.endswith(".tmp")], [])

    def only_actual(self, dataset, responses):
        """Every output point is exactly a (date, price) pair the provider returned for that ETF."""
        for sym, pts in dataset.items():
            if sym not in responses:
                continue
            src = {d: round(p, 2) for d, p in zip(responses[sym]["dates"], responses[sym]["prices"])
                   if isinstance(p, (int, float)) and not isinstance(p, bool) and math.isfinite(p) and p > 0}
            for pt in pts:
                self.assertIn(pt["x"], src, "%s: manufactured date %s" % (sym, pt["x"]))
                self.assertEqual(src[pt["x"]], pt["y"], "%s: price changed on %s" % (sym, pt["x"]))


# 1 --------------------------------------------------------------------------
class T01Success(Base):
    def test_full_success_schema_sidecar_and_outcome(self):
        fake = Fake(all_good())
        r = self.run_(fake)
        self.assertEqual((r["exit_status"], r["outcome"]), (st.EXIT_OK, "success"))
        ds = self.dataset()
        self.assertEqual(list(ds), SYMS)
        for sym, pts in ds.items():
            self.assertEqual([set(p) for p in pts], [{"x", "y"}] * len(D))
            self.assertEqual([p["x"] for p in pts], D)
        self.only_actual(ds, fake.responses)
        sc = self.sidecar()
        self.assertEqual(sc["schema"], st.SIDECAR_SCHEMA)
        self.assertEqual(sc["dataset_sha256"], ct.sha256_hex(self.raw()))
        self.assertEqual(sc["last_attempt"]["counts"], {"requested": 11, "refreshed": 11, "retained": 0, "unavailable": 0})
        self.assertTrue(all(i["status"] == "refreshed" and i["last_successful_refresh_known"] for i in sc["instruments"].values()))
        self.assertFalse(sc["review"]["required_before_production_use"])
        self.assertEqual(st.verify_consistency(self.ds, self.sc)["status"], "consistent")
        self.no_temp_files()

    def test_prices_are_rounded_to_two_decimals_and_output_is_strict_json(self):
        r = {s: resp(D[:2], [10.123456, 20.987654]) for s in SYMS}
        self.run_(Fake(r))
        self.assertEqual([p["y"] for p in self.dataset()["XLK"]], [10.12, 20.99])
        with self.assertRaises(ValueError):
            st.serialize_document({"XLK": [{"x": "2026-01-01", "y": float("nan")}]})


# 2 --------------------------------------------------------------------------
class T02LateStart(Base):
    def test_leading_nulls_are_removed_not_filled_and_no_common_start(self):
        r = all_good()
        r["XLRE"] = resp(D, [None, float("nan"), None, 50.0, 51.0])      # first valid price after empty dates
        fake = Fake(r)
        self.run_(fake)
        ds = self.dataset()
        self.assertEqual([p["x"] for p in ds["XLRE"]], ["2026-10-01", "2026-10-02"])
        self.assertEqual([p["y"] for p in ds["XLRE"]], [50.0, 51.0])
        self.assertEqual([p["x"] for p in ds["XLK"]], D)                  # others keep their own start
        self.only_actual(ds, r)
        att = self.sidecar()["instruments"]["XLRE"]["attempt"]
        self.assertEqual(att["removed_rows"]["null"], 2)
        self.assertEqual(att["removed_rows"]["nan"], 1)
        self.assertEqual(att["removed_position"], {"leading": 3, "internal": 0, "trailing": 0})
        self.assertEqual((att["first"], att["usable_observations"]), ("2026-10-01", 2))

    def test_many_empty_dates_before_first_price_manufacture_nothing(self):
        dates = ["2026-09-%02d" % d for d in range(1, 26) if d % 7 not in (6, 0)]
        prices = [None] * (len(dates) - 2) + [42.5, 43.0]
        r = all_good()
        r["XLC"] = resp(dates, prices)
        self.run_(Fake(r))
        pts = self.dataset()["XLC"]
        self.assertEqual(pts, [{"x": dates[-2], "y": 42.5}, {"x": dates[-1], "y": 43.0}])

    def test_trailing_nulls_are_counted_as_trailing(self):
        r = all_good()
        r["XLU"] = resp(D, [1.0, 2.0, 3.0, None, None])
        self.run_(Fake(r))
        self.assertEqual(self.sidecar()["instruments"]["XLU"]["attempt"]["removed_position"],
                         {"leading": 0, "internal": 0, "trailing": 2})


# 3 --------------------------------------------------------------------------
class T03InternalGaps(Base):
    def test_internal_missing_prices_stay_gaps(self):
        r = all_good()
        r["XLF"] = resp(D, [10.0, None, 12.0, float("nan"), 14.0])
        self.run_(Fake(r))
        pts = self.dataset()["XLF"]
        self.assertEqual([p["x"] for p in pts], [D[0], D[2], D[4]])
        self.assertEqual([p["y"] for p in pts], [10.0, 12.0, 14.0])
        att = self.sidecar()["instruments"]["XLF"]["attempt"]
        self.assertEqual(att["removed_position"]["internal"], 2)
        self.assertEqual(att["max_gap_days"], 2)
        self.assertTrue(any("internal missing" in w for w in att["warnings"]))


# 4 --------------------------------------------------------------------------
class T04DifferentDates(Base):
    def test_each_etf_keeps_its_own_observation_dates(self):
        r = all_good()
        r["XLK"] = resp(D[:3], [1.0, 2.0, 3.0])
        r["XLF"] = resp(D[2:], [7.0, 8.0, 9.0])
        self.run_(Fake(r))
        ds = self.dataset()
        self.assertEqual([p["x"] for p in ds["XLK"]], D[:3])
        self.assertEqual([p["x"] for p in ds["XLF"]], D[2:])
        self.only_actual(ds, r)


# 5 --------------------------------------------------------------------------
class T05Unsorted(Base):
    def test_unsorted_dates_are_paired_then_sorted(self):
        order = [3, 0, 4, 2, 1]
        dates = [D[i] for i in order]
        prices = [30.0, 10.0, 50.0, 20.0, 40.0]
        pairs = dict(zip(dates, prices))
        r = all_good()
        r["XLV"] = resp(dates, prices)
        self.run_(Fake(r))
        pts = self.dataset()["XLV"]
        self.assertEqual([p["x"] for p in pts], sorted(D))
        self.assertTrue(all(pairs[p["x"]] == p["y"] for p in pts))
        self.assertTrue(self.sidecar()["instruments"]["XLV"]["attempt"]["reordered"])
        self.assertFalse(self.sidecar()["instruments"]["XLK"]["attempt"]["reordered"])


# 6 --------------------------------------------------------------------------
class T06BadDates(Base):
    def reject(self, response, needle):
        r = all_good()
        r["XLB"] = response
        res = self.run_(Fake(r))
        rec = res["instruments"]["XLB"]
        self.assertEqual(rec["status"], "unavailable")
        self.assertTrue(any(needle in x for x in rec["reasons"]), rec["reasons"])
        self.assertEqual(res["instruments"]["XLK"]["status"], "refreshed")
        self.assertNotIn("XLB", self.dataset())

    def test_invalid_dates(self):
        self.reject(resp(["2026-13-01", "26-09-30", None, 20260930, "2026-09-29"], [1, 2, 3, 4, 5]), "invalid date")

    def test_duplicate_dates(self):
        self.reject(resp([D[0], D[1], D[1]], [1.0, 2.0, 3.0]), "duplicate date")

    def test_future_dates_relative_to_supplied_asof(self):
        self.reject(resp([D[0], "2026-10-03"], [1.0, 2.0]), "after as-of 2026-10-02")

    def test_asof_date_itself_is_accepted(self):
        r = all_good()
        self.run_(Fake(r))
        self.assertEqual(self.dataset()["XLK"][-1]["x"], "2026-10-02")

    def test_unequal_lengths(self):
        self.reject(resp(D, [1.0, 2.0]), "unequal lengths: 5 dates vs 2 prices")


# 7 --------------------------------------------------------------------------
class T07Prices(Base):
    def test_every_invalid_price_kind_is_removed_counted_and_never_substituted(self):
        dates = ["2026-09-%02d" % d for d in range(1, 15)]
        prices = [10.0, None, float("nan"), float("inf"), float("-inf"), "12.3", True, False, 0, -5.0,
                  0.004, 10 ** 400, 11.5, 12.25]
        r = all_good()
        r["XLP"] = resp(dates, prices)
        res = self.run_(Fake(r))
        pts = self.dataset()["XLP"]
        self.assertEqual(pts, [{"x": "2026-09-01", "y": 10.0}, {"x": "2026-09-13", "y": 11.5}, {"x": "2026-09-14", "y": 12.25}])
        att = res["instruments"]["XLP"]["attempt"]
        self.assertEqual(att["removed_rows"], {"null": 1, "nan": 1, "infinite": 3, "non_numeric": 3, "non_positive": 3})
        self.assertEqual(att["removed_total"], 11)
        self.assertEqual(att["removed_position"], {"leading": 0, "internal": 11, "trailing": 0})
        self.assertEqual(att["usable_observations"], 3)
        json.dumps(self.dataset(), allow_nan=False)


# 8 --------------------------------------------------------------------------
class T08Failures(Base):
    def one(self, response, needle, status="unavailable"):
        r = all_good()
        r["XLY"] = response
        res = self.run_(Fake(r))
        rec = res["instruments"]["XLY"]
        self.assertEqual(rec["status"], status)
        self.assertTrue(any(needle in x for x in rec["reasons"]), rec["reasons"])
        return res

    def test_missing_columns_and_shapes(self):
        self.one({"dates": D}, "missing required column(s): prices")
        self.one({"prices": [1.0]}, "missing required column(s): dates")
        self.one([1, 2, 3], "not a mapping")
        self.one({"dates": "x", "prices": "y", "price_field": "Close"}, "must be lists")

    def test_wrong_or_absent_price_field_is_rejected_fields_are_never_mixed(self):
        self.one(resp(D, [1.0] * 5, field="Adj Close"), "is not the requested 'Close'")
        self.one({"dates": D, "prices": [1.0] * 5}, "is not the requested 'Close'")

    def test_empty_response_zero_rows_and_all_null(self):
        self.one(resp([], []), "empty response")
        self.one(resp(D, [None] * 5), "no usable observations")
        self.one(resp(D, [float("nan")] * 5), "no usable observations")

    def test_per_etf_errors_missing_and_none(self):
        r = all_good()
        r["XLY"] = KeyError("no Close column for XLY")
        del r["XLE"]
        r["XLI"] = None
        res = self.run_(Fake(r))
        self.assertEqual(res["exit_status"], st.EXIT_PARTIAL)
        self.assertTrue(any("provider error: KeyError" in x for x in res["instruments"]["XLY"]["reasons"]))
        self.assertTrue(any("no response for symbol XLE" in x for x in res["instruments"]["XLE"]["reasons"]))
        self.assertTrue(any("no response" in x for x in res["instruments"]["XLI"]["reasons"]))
        self.assertEqual(res["counts"], {"requested": 11, "refreshed": 8, "retained": 0, "unavailable": 3})

    def test_timeout_and_other_request_failures_fail_every_etf(self):
        for exc in (TimeoutError("timed out"), ConnectionError("down"), RuntimeError("boom")):
            with self.subTest(type(exc).__name__):
                res = self.run_(Fake(exc=exc))
                self.assertEqual((res["exit_status"], res["outcome"]), (st.EXIT_FAILED, "failed"))
                self.assertTrue(all(i["status"] == "unavailable" and type(exc).__name__ in i["reasons"][0]
                                    for i in res["instruments"].values()))
                self.assertFalse(os.path.exists(self.ds))

    def test_non_mapping_and_empty_mapping_from_downloader(self):
        for ret in ([], None, "x", {}):
            with self.subTest(repr(ret)):
                res = self.run_(Fake(ret))
                self.assertEqual(res["exit_status"], st.EXIT_FAILED)
                self.assertFalse(os.path.exists(self.ds))


# 9 --------------------------------------------------------------------------
class T09Partial(Base):
    def setUp(self):
        super().setUp()
        self.legacy = legacy_doc(**{s: [(D[0], 5.0), (D[1], 6.0)] for s in SYMS})

    def test_partial_success_with_legacy_fallback_is_disclosed(self):
        self.put(self.legacy)
        r = all_good()
        r["XLE"] = TimeoutError("per-symbol timeout")
        res = self.run_(Fake(r))
        self.assertEqual((res["exit_status"], res["outcome"]), (st.EXIT_PARTIAL, "partial"))
        ds = self.dataset()
        self.assertEqual(ds["XLE"], self.legacy["XLE"])                       # retained unchanged
        self.assertEqual(len(ds["XLK"]), 5)                                    # refreshed
        rec = res["instruments"]["XLE"]
        self.assertEqual((rec["status"], rec["provenance"]), ("retained", "retained_legacy_unverified"))
        self.assertFalse(rec["last_successful_refresh_known"])
        self.assertIsNone(rec["last_successful_refresh_utc"])
        self.assertTrue(rec["review_required"])
        self.assertTrue(res["review_required"])
        self.assertTrue(any("per-symbol timeout" in x for x in rec["reasons"]))
        sc = self.sidecar()
        self.assertIn("XLE", sc["review"]["instruments"])
        self.assertEqual(sc["last_attempt"]["counts"]["retained"], 1)

    def test_known_prior_refresh_time_is_preserved_when_a_later_refresh_fails(self):
        self.run_(Fake(all_good()), clock=NOW)
        first = self.sidecar()["instruments"]["XLE"]["last_successful_refresh_utc"]
        r = all_good()
        r["XLE"] = None
        res = self.run_(Fake(r), clock=NOW2)
        rec = res["instruments"]["XLE"]
        self.assertEqual((rec["status"], rec["provenance"]), ("retained", "retained_prior_refresh_known"))
        self.assertEqual(rec["last_successful_refresh_utc"], first)
        self.assertTrue(rec["last_successful_refresh_known"])
        self.assertFalse(rec["review_required"])
        self.assertEqual(self.sidecar()["instruments"]["XLK"]["last_successful_refresh_utc"], NOW2.isoformat())

    def test_saved_ticker_that_is_not_requested_is_carried_over_and_flagged(self):
        doc = dict(self.legacy)
        doc["XLZ"] = [{"x": D[0], "y": 1.0}]
        self.put(doc)
        res = self.run_(Fake(all_good()))
        self.assertEqual(self.dataset()["XLZ"], doc["XLZ"])
        self.assertEqual(res["instruments"]["XLZ"]["status"], "not_requested_retained")
        self.assertTrue(res["review_required"])


# 10 -------------------------------------------------------------------------
class T10AllFail(Base):
    def test_all_failures_leave_existing_dataset_byte_identical(self):
        raw = self.put(legacy_doc(**{s: [(D[0], 5.0)] for s in SYMS}))
        mtime = os.stat(self.ds).st_mtime_ns
        for fake in (Fake(exc=TimeoutError("t")), Fake({}), Fake({s: resp(D, [None] * 5) for s in SYMS})):
            res = self.run_(fake)
            self.assertEqual((res["exit_status"], res["outcome"], res["dataset_replaced"]), (st.EXIT_FAILED, "failed", False))
            self.assertEqual(self.raw(), raw)
            self.assertEqual(os.stat(self.ds).st_mtime_ns, mtime)
            sc = self.sidecar()
            self.assertFalse(sc["dataset_replaced_by_this_attempt"])
            self.assertEqual(sc["dataset_sha256"], ct.sha256_hex(raw))
            self.assertTrue(all(i["status"] == "retained" for i in sc["instruments"].values()))
            self.assertTrue(res["review_required"])                           # unverified legacy retained
        self.no_temp_files()

    def test_all_failures_without_prior_output_create_no_dataset(self):
        res = self.run_(Fake(exc=TimeoutError("t")))
        self.assertEqual(res["exit_status"], st.EXIT_FAILED)
        self.assertFalse(os.path.exists(self.ds))
        self.assertIsNone(self.sidecar()["dataset_sha256"])


# 11 -------------------------------------------------------------------------
class T11LegacyCoverageLoss(Base):
    def legacy(self):
        flat = [("2026-09-21", 30.0), ("2026-09-22", 30.0), ("2026-09-23", 30.0), ("2026-09-24", 30.0)]
        real = [("2026-09-25", 31.0), ("2026-09-28", 32.0), ("2026-09-29", 33.0), ("2026-09-30", 34.0)]
        return legacy_doc(XLRE=flat + real)

    def test_clean_shorter_candidate_exposes_loss_and_restores_nothing(self):
        self.put(self.legacy())
        cand = resp(["2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"], [31.0, 32.0, 33.5, 34.0, 35.0])
        r = all_good()
        r["XLRE"] = cand
        res = self.run_(Fake(r))
        pts = self.dataset()["XLRE"]
        self.assertEqual([p["x"] for p in pts], cand["dates"])                # the 4 filled dates are NOT merged back
        self.assertNotIn("2026-09-21", [p["x"] for p in pts])
        rec = res["instruments"]["XLRE"]
        self.assertEqual(rec["status"], "refreshed")
        c = rec["comparison_with_prior"]
        self.assertEqual((c["dates_lost"]["count"], c["dates_lost"]["first"], c["dates_lost"]["last"]),
                         (4, "2026-09-21", "2026-09-24"))
        self.assertEqual((c["dates_lost"]["before_candidate_first"], c["dates_lost"]["inside_candidate_range"],
                          c["dates_lost"]["after_candidate_last"]), (4, 0, 0))
        self.assertEqual(c["dates_lost"]["runs"], [{"first": "2026-09-21", "last": "2026-09-24", "count": 4}])
        self.assertTrue(c["starts_later"])
        self.assertFalse(c["ends_earlier"])
        self.assertEqual(c["prior"]["leading_identical_run"], 4)
        self.assertEqual((c["revisions"]["revised_dates"], c["revisions"]["max_abs_change"], c["revisions"]["cause"]),
                         (1, 0.5, "not inferred"))
        self.assertEqual(c["dates_added"]["count"], 1)
        self.assertTrue(rec["review_required"])
        self.assertTrue(res["review_required"])
        self.assertTrue(self.sidecar()["review"]["required_before_production_use"])
        self.assertIn("XLRE", self.sidecar()["review"]["instruments"])
        self.assertFalse(res["instruments"]["XLK"]["review_required"])

    def test_inside_range_loss_and_end_earlier_are_recorded(self):
        self.put(legacy_doc(XLK=[(D[0], 1.0), (D[1], 2.0), (D[2], 3.0), (D[3], 4.0)]))
        r = all_good()
        r["XLK"] = resp([D[0], D[2]], [1.0, 3.0])
        c = self.run_(Fake(r))["instruments"]["XLK"]["comparison_with_prior"]
        self.assertEqual((c["dates_lost"]["inside_candidate_range"], c["dates_lost"]["after_candidate_last"]), (1, 1))
        self.assertTrue(c["ends_earlier"])

    def test_pure_extension_without_revisions_needs_no_review(self):
        self.put(legacy_doc(XLK=[(D[0], 100.0), (D[1], 101.0)]))
        res = self.run_(Fake(all_good()))
        rec = res["instruments"]["XLK"]
        self.assertEqual((rec["review_required"], rec["comparison_with_prior"]["dates_lost"]["count"]), (False, 0))
        self.assertFalse(res["review_required"])

    def test_retained_legacy_with_leading_identical_run_is_flagged_as_possible_fill(self):
        self.put(legacy_doc(XLC=[("2026-09-%02d" % d, 25.0) for d in range(1, 13)] + [("2026-09-14", 26.0)]))
        r = all_good()
        r["XLC"] = RuntimeError("down")
        rec = self.run_(Fake(r))["instruments"]["XLC"]
        self.assertEqual(rec["coverage"]["leading_identical_run"], 12)
        self.assertTrue(any("possible fill" in x for x in rec["review_reasons"]))

    def test_candidate_never_modifies_the_prior_entries_it_replaces_or_retains(self):
        legacy = legacy_doc(XLK=[(D[0], 9.0)], XLF=[(D[0], 8.0)])
        self.put(legacy)
        r = all_good()
        r["XLF"] = TimeoutError("t")
        self.run_(Fake(r))
        self.assertEqual(self.dataset()["XLF"], legacy["XLF"])
        self.assertNotIn({"x": D[0], "y": 9.0}, self.dataset()["XLK"][1:])


# 12 -------------------------------------------------------------------------
class T12CorruptPrior(Base):
    def test_unreadable_or_invalid_prior_output_is_never_overwritten(self):
        cases = {"garbage": b"\x00\xffnot json", "nan_token": b'{"XLK": NaN}', "infinity": b'{"XLK": [{"x":"2026-01-01","y":Infinity}]}',
                 "duplicate_keys": b'{"XLK": [], "XLK": []}', "list_top_level": b"[1,2]", "empty_file": b""}
        for name, raw in cases.items():
            with self.subTest(name):
                self.put(raw=raw)
                fake = Fake(all_good())
                res = self.run_(fake)
                self.assertEqual((res["exit_status"], res["outcome"]), (st.EXIT_REFUSED, "refused"))
                self.assertEqual(fake.calls, [])                                # nothing requested
                self.assertEqual(self.raw(), raw)
                self.assertFalse(os.path.exists(self.sc))

    def test_unusable_single_series_is_replaced_when_candidate_valid_and_flagged(self):
        self.put({"XLK": "oops", "XLF": [{"x": "bad-date", "y": 1.0}]})
        res = self.run_(Fake(all_good()))
        self.assertEqual(res["instruments"]["XLK"]["status"], "refreshed")
        self.assertTrue(res["instruments"]["XLK"]["review_required"])
        self.assertTrue(any("unusable" in x for x in res["instruments"]["XLK"]["reasons"]))

    def test_unusable_series_is_carried_over_unchanged_when_refresh_fails(self):
        bad = {"x": "bad-date", "y": 1.0}
        self.put({"XLK": [bad]})
        r = all_good()
        r["XLK"] = TimeoutError("t")
        res = self.run_(Fake(r))
        self.assertEqual(self.dataset()["XLK"], [bad])
        self.assertEqual(res["instruments"]["XLK"]["status"], "unavailable")


# 13 -------------------------------------------------------------------------
class T13WriteFailures(Base):
    def test_serialization_failure_keeps_previous_dataset(self):
        raw = self.put(legacy_doc(XLK=[(D[0], 5.0)]))
        calls = []

        def flaky(doc):
            calls.append(1)
            if len(calls) == 1:
                raise ValueError("Out of range float values are not JSON compliant")
            return ct.serialize_document(doc)
        with mock.patch.object(st, "serialize_document", flaky):
            res = self.run_(Fake(all_good()))
        self.assertEqual((res["exit_status"], res["outcome"], res["dataset_replaced"]), (st.EXIT_WRITE_FAILED, "write_failed", False))
        self.assertIn("serialization failed", res["dataset_error"])
        self.assertEqual(self.raw(), raw)
        self.assertEqual(self.sidecar()["dataset_sha256"], ct.sha256_hex(raw))   # sidecar describes what is on disk
        self.no_temp_files()

    def test_dataset_write_failure_keeps_previous_dataset(self):
        raw = self.put(legacy_doc(XLK=[(D[0], 5.0)]))
        res = self.run_(Fake(all_good()), io=FailOn(st.DATASET_FILE))
        self.assertEqual(res["exit_status"], st.EXIT_WRITE_FAILED)
        self.assertEqual(self.raw(), raw)
        self.no_temp_files()

    def test_replace_failure_leaves_previous_dataset_and_no_temp_file(self):
        raw = self.put(legacy_doc(XLK=[(D[0], 5.0)]))

        def broken_replace(src, dst):
            raise OSError("access denied")
        res = self.run_(Fake(all_good()), io=st.FileIO(replace=broken_replace))
        self.assertEqual(res["exit_status"], st.EXIT_WRITE_FAILED)
        self.assertIn("access denied", res["dataset_error"])
        self.assertEqual(self.raw(), raw)
        self.assertFalse(res["sidecar_written"])
        self.no_temp_files()

    def test_readback_validation_failure_prevents_replacement(self):
        raw = self.put(legacy_doc(XLK=[(D[0], 5.0)]))
        with mock.patch.object(st, "_verify_dataset_bytes", side_effect=st.WriteError("re-read dataset differs")):
            res = self.run_(Fake(all_good()))
        self.assertEqual(res["exit_status"], st.EXIT_WRITE_FAILED)
        self.assertEqual(self.raw(), raw)
        self.no_temp_files()

    def test_fsync_failure_is_a_write_failure(self):
        def bad_fsync(fd):
            raise OSError("disk full")
        res = self.run_(Fake(all_good()), io=st.FileIO(fsync=bad_fsync))
        self.assertEqual(res["exit_status"], st.EXIT_WRITE_FAILED)
        self.assertFalse(os.path.exists(self.ds))
        self.no_temp_files()


# 14 -------------------------------------------------------------------------
class T14Consistency(Base):
    def test_sidecar_hash_links_dataset_and_tampering_is_detected(self):
        self.run_(Fake(all_good()))
        self.assertEqual(st.main(["--verify", "--output-dir", self.dir], log=lambda *_: None), st.EXIT_OK)
        with open(self.ds, "ab") as fh:
            fh.write(b" ")
        self.assertEqual(st.verify_consistency(self.ds, self.sc)["status"], "dataset_hash_mismatch")
        self.assertEqual(st.main(["--verify", "--output-dir", self.dir], log=lambda *_: None), st.EXIT_VERIFY_FAILED)

    def test_metadata_write_failure_after_dataset_replaced(self):
        res = self.run_(Fake(all_good()), io=FailOn(st.SIDECAR_FILE))
        self.assertEqual(res["exit_status"], st.EXIT_SIDECAR_FAILED)
        self.assertTrue(res["dataset_replaced"])
        self.assertTrue(res["outcome"].endswith("+sidecar_failed"))
        self.assertEqual(st.verify_consistency(self.ds, self.sc)["status"], "sidecar_missing_or_invalid")

    def test_stale_sidecar_is_detected_and_a_later_good_run_repairs_it(self):
        self.run_(Fake(all_good()), clock=NOW)
        old_sidecar = self.raw(self.sc)
        changed = {s: good(offset=k * 10 + 0.5) for k, s in enumerate(SYMS)}        # different bytes than run 1
        r = self.run_(Fake(changed), clock=NOW2, io=FailOn(st.SIDECAR_FILE))
        self.assertEqual(r["exit_status"], st.EXIT_SIDECAR_FAILED)
        self.assertEqual(self.raw(self.sc), old_sidecar)                          # old sidecar left in place
        self.assertEqual(st.verify_consistency(self.ds, self.sc)["status"], "dataset_hash_mismatch")
        self.run_(Fake(changed), clock=NOW2)
        self.assertEqual(st.verify_consistency(self.ds, self.sc)["status"], "consistent")

    def test_sidecar_describes_request_definition_and_fill_policy(self):
        self.run_(Fake(all_good()))
        sc = self.sidecar()
        req = sc["request"]
        self.assertEqual((req["start"], req["end"], req["interval"]), ("2005-01-01", "2026-10-02", "1d"))
        self.assertEqual((req["auto_adjust"], req["price_field"]), ("explicit: False", "explicit: 'Close'"))
        self.assertEqual(req["download_options"], {"interval": "1d", "auto_adjust": False, "price_field": "Close"})
        self.assertEqual(req["symbols"], SYMS)
        self.assertIn("dividend-inclusive total return", sc["price_definition"]["not_claimed"])
        self.assertTrue(any("production file" in x for x in sc["price_definition"]["not_claimed"]))
        self.assertTrue(sc["fill_policy"].startswith("none"))
        self.assertIn("unknown", sc["historical_provenance"])


# 15 -------------------------------------------------------------------------
class T15SectorOnly(Base):
    def test_import_has_no_side_effects_and_loads_no_provider_or_macro_code(self):
        with tempfile.TemporaryDirectory() as cwd:
            code = ("import sys; sys.dont_write_bytecode=True; sys.path.insert(0, %r); import sector_tracker; "
                    "bad=[m for m in ('yfinance','pandas','macro_engine','urllib.request') if m in sys.modules]; "
                    "print(','.join(bad)); sys.exit(1 if bad else 0)" % ROOT)
            p = subprocess.run([sys.executable, "-c", code], cwd=cwd, capture_output=True, text=True, timeout=60)
            self.assertEqual((p.returncode, p.stdout.strip()), (0, ""), p.stderr)
            self.assertEqual(os.listdir(cwd), [])

    def test_source_has_no_event_news_or_fill_code(self):
        import ast
        with open(os.path.join(ROOT, "sector_tracker.py"), encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        docstrings = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and ast.get_docstring(node, clean=False) is not None:
                docstrings.add(id(node.body[0].value))
        names, strings, imports = set(), [], set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                names.add(node.id)
            elif isinstance(node, ast.Attribute):
                names.add(node.attr)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
                strings.append(node.value)
            elif isinstance(node, ast.Import):
                imports.update(a.name for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                imports.add(node.module)
        self.assertEqual(names & {"ffill", "bfill", "fillna", "interpolate", "backfill", "pad"}, set())
        self.assertEqual({i for i in imports if i and i.split(".")[0] in ("macro_engine", "urllib", "xml", "requests")}, set())
        self.assertEqual([s for s in strings if "live_news" in s or "macro_events" in s], [])

    def test_refresh_touches_only_its_dataset_and_sidecar(self):
        others = {"macro_events.json": b'[{"name":"x"}]', "live_news.json": b"[]", "commodities_data.json": b"{}",
                  "equity_data.json": b"{}", "index.html.txt": b"x"}
        for n, b in others.items():
            with open(os.path.join(self.dir, n), "wb") as fh:
                fh.write(b)
        before = {n: self.raw(os.path.join(self.dir, n)) for n in others}
        self.run_(Fake(all_good()))
        self.assertEqual({n: self.raw(os.path.join(self.dir, n)) for n in others}, before)
        self.assertEqual(sorted(os.listdir(self.dir)), sorted(list(others) + [st.DATASET_FILE, st.SIDECAR_FILE]))

    def test_cli_requires_explicit_output_dir(self):
        with self.assertRaises(SystemExit) as cm, mock.patch("sys.stderr"):
            st.main([])
        self.assertEqual(cm.exception.code, st.EXIT_USAGE)

    def test_cli_refuses_missing_directory_and_application_folder(self):
        fake = Fake(all_good())
        log = []
        self.assertEqual(st.main(["--output-dir", os.path.join(self.dir, "nope")], downloader=fake, log=log.append), st.EXIT_REFUSED)
        with open(os.path.join(self.dir, "index.html"), "w") as fh:
            fh.write("x")
        self.assertEqual(st.main(["--output-dir", self.dir], downloader=fake, log=log.append), st.EXIT_REFUSED)
        self.assertEqual(fake.calls, [])
        self.assertFalse(os.path.exists(self.ds))
        self.assertEqual(st.main(["--output-dir", self.dir, "--allow-app-directory"], downloader=fake,
                                 clock=lambda: NOW, log=lambda *_: None), st.EXIT_OK)
        self.assertTrue(os.path.exists(self.ds))

    def test_cli_exit_codes_follow_the_outcome(self):
        self.assertEqual(st.main(["--output-dir", self.dir], downloader=Fake(all_good()), clock=lambda: NOW, log=lambda *_: None), 0)
        r = all_good()
        r["XLK"] = None
        self.assertEqual(st.main(["--output-dir", self.dir], downloader=Fake(r), clock=lambda: NOW2, log=lambda *_: None), 2)
        self.assertEqual(st.main(["--output-dir", self.dir], downloader=Fake(exc=TimeoutError("t")), clock=lambda: NOW2, log=lambda *_: None), 1)


# 16 -------------------------------------------------------------------------
class T16ProviderOptions(Base):
    def test_exact_options_reach_the_injected_downloader(self):
        fake = Fake(all_good())
        self.run_(fake)
        self.assertEqual(len(fake.calls), 1)                                      # one request, no retries
        call = fake.calls[0]
        self.assertEqual(call["symbols"], SYMS)
        self.assertEqual((call["start"], call["end"]), ("2005-01-01", "2026-10-02"))
        self.assertEqual(call["options"], {"interval": "1d", "auto_adjust": False, "price_field": "Close"})
        self.assertIs(call["options"]["auto_adjust"], False)

    def test_real_adapter_passes_explicit_provider_arguments_and_selects_close(self):
        try:
            import pandas as pd
        except ImportError:
            self.skipTest("pandas not installed")
        idx = pd.to_datetime(["2026-09-28", "2026-09-29", "2026-09-30"])
        nan = float("nan")
        cols = pd.MultiIndex.from_tuples([("Close", "XLK"), ("Adj Close", "XLK"), ("Close", "XLRE"), ("Adj Close", "XLRE")])
        frame = pd.DataFrame([[10.0, 99.0, nan, nan], [11.0, 98.0, nan, nan], [12.0, 97.0, 40.0, 39.0]], index=idx, columns=cols)
        seen = {}

        def download(tickers, start=None, end=None, interval=None, auto_adjust=None, timeout=None):
            seen.update(tickers=tickers, start=start, end=end, interval=interval, auto_adjust=auto_adjust, timeout=timeout)
            return frame
        stub = mock.Mock(download=download)
        with mock.patch.dict(sys.modules, {"yfinance": stub}):
            out = st.yfinance_downloader(["XLK", "XLRE"], "2005-01-01", "2026-10-02", **st.REQUEST_OPTIONS)
            self.assertEqual((seen["tickers"], seen["start"], seen["end"], seen["interval"]), (["XLK", "XLRE"], "2005-01-01", "2026-10-02", "1d"))
            self.assertIs(seen["auto_adjust"], False)
            self.assertEqual(seen["timeout"], st.DOWNLOAD_TIMEOUT_S)
            self.assertEqual((out["XLK"]["price_field"], out["XLK"]["prices"]), ("Close", [10.0, 11.0, 12.0]))
            # end to end through the production refresh: leading alignment NaNs must not become prices
            res = self.run_(lambda s, a, b, **o: st.yfinance_downloader(["XLK", "XLRE"], a, b, **o), symbols=["XLK", "XLRE"])
        self.assertEqual(res["exit_status"], st.EXIT_OK)
        self.assertEqual(self.dataset()["XLRE"], [{"x": "2026-09-30", "y": 40.0}])
        self.assertEqual(len(self.dataset()["XLK"]), 3)
        self.assertNotIn("yfinance", sys.modules)

    def test_real_adapter_missing_close_column_is_a_per_etf_failure(self):
        try:
            import pandas as pd
        except ImportError:
            self.skipTest("pandas not installed")
        idx = pd.to_datetime(["2026-09-30"])
        frame = pd.DataFrame([[10.0, 11.0]], index=idx, columns=pd.MultiIndex.from_tuples([("Close", "XLK"), ("Adj Close", "XLF")]))
        stub = mock.Mock(download=lambda tickers, start=None, end=None, interval=None, auto_adjust=None: frame)
        with mock.patch.dict(sys.modules, {"yfinance": stub}):
            out = st.yfinance_downloader(["XLK", "XLF"], "2005-01-01", "2026-10-02")
        self.assertEqual(out["XLK"]["prices"], [10.0])
        self.assertIsInstance(out["XLF"], KeyError)                                # only Adj Close exists -> not substituted


# real files, read-only ------------------------------------------------------
LEGACY_PRODUCTION_SHA256 = "E9649245860CB4638E04A983D651201B354DF1B1E4CCAD7543F56A968DB20247"
PROMOTED_DATASET_SHA256 = "EEA9890432BC8EA3547F824378EA3E3B722DFE59DFE28270C14CAA3E505A3345"
LEGACY_FILL_FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "legacy_sector_fill_shape.json")


class TLegacyFillShape(Base):
    """
    Legacy-data regression: a small checked-in fixture with the important pre-promotion shapes
    (all 11 ETFs usable; XLRE/XLC start with a long identical-price run). It must run with no
    archive/ folder present. Copied into a temp dir; the fixture file is only read.
    """

    def test_fixture_is_usable_prior_and_fallback_flags_possible_fill(self):
        self.assertTrue(os.path.isfile(LEGACY_FILL_FIXTURE), "missing fixture %s" % LEGACY_FILL_FIXTURE)
        self.assertNotIn("archive", os.path.normpath(LEGACY_FILL_FIXTURE).split(os.sep))
        shutil.copyfile(LEGACY_FILL_FIXTURE, self.ds)
        status, data, _raw, why = ct.load_previous(self.ds)
        self.assertEqual((status, why), ("ok", None))
        self.assertEqual(list(data), SYMS)
        self.assertTrue(all(st.check_previous_points(v)[1] is None for v in data.values()))
        raw = self.raw()
        res = self.run_(Fake(exc=TimeoutError("offline test")))
        self.assertEqual(res["exit_status"], st.EXIT_FAILED)
        self.assertEqual(self.raw(), raw)
        flagged = [s for s, r in res["instruments"].items() if any("possible fill" in x for x in r["review_reasons"])]
        self.assertIn("XLRE", flagged)
        self.assertIn("XLC", flagged)
        self.assertEqual(sorted(flagged), ["XLC", "XLRE"])
        self.assertGreaterEqual(res["instruments"]["XLRE"]["coverage"]["leading_identical_run"], st.LEADING_RUN_WARN)
        self.assertGreaterEqual(res["instruments"]["XLC"]["coverage"]["leading_identical_run"], st.LEADING_RUN_WARN)
        self.assertTrue(all(r["provenance"] == "retained_legacy_unverified" for r in res["instruments"].values()))


class TPromotedProduction(Base):
    """Integrity of the promoted production dataset and its sidecar (read-only; fallback run uses a temp copy)."""
    DS = os.path.join(ROOT, "sector_historical.json")
    SC = os.path.join(ROOT, "sector_historical_meta.json")

    def setUp(self):
        super().setUp()
        if not (os.path.exists(self.DS) and os.path.exists(self.SC)):
            self.skipTest("promoted production dataset/sidecar not present")

    def test_dataset_and_sidecar_are_consistent_and_dataset_is_the_reviewed_one(self):
        self.assertEqual(st.verify_consistency(self.DS, self.SC)["status"], "consistent")
        self.assertEqual(sha_file(self.DS).upper(), PROMOTED_DATASET_SHA256)

    def test_eleven_series_clean_first_dates_and_end_date(self):
        data = ct.strict_loads(self.raw(self.DS))
        self.assertEqual(list(data), SYMS)
        for s, pts in data.items():
            self.assertTrue(st.check_previous_points(pts)[1] is None, s)
            dates = [p["x"] for p in pts]
            self.assertEqual(dates, sorted(set(dates)), s)                         # sorted, unique
            self.assertEqual(dates[-1], "2026-10-01", s)
            self.assertTrue(all(isinstance(p["y"], (int, float)) and math.isfinite(p["y"]) and p["y"] > 0 for p in pts), s)
        self.assertEqual(data["XLRE"][0]["x"], "2015-10-08")                       # no back-filled pre-listing run
        self.assertEqual(data["XLC"][0]["x"], "2018-06-19")
        self.assertTrue(all(data[s][0]["x"] == "2005-01-03" for s in SYMS if s not in ("XLRE", "XLC")))

    def test_sidecar_metadata_is_accurate_and_records_the_correction(self):
        m = ct.strict_loads(self.raw(self.SC))
        self.assertEqual(m["schema"], st.SIDECAR_SCHEMA)
        self.assertEqual(m["dataset_sha256"].upper(), PROMOTED_DATASET_SHA256)
        self.assertIs(m["request"]["download_options"]["auto_adjust"], False)
        self.assertIsNone(m["request"]["timeout_seconds"])                         # the 30 s claim was inaccurate
        self.assertIs(m["request"]["timeout_forwarded"], False)
        self.assertEqual(m["metadata_correction"]["staged_value"], 30)
        self.assertEqual(m["metadata_correction"]["original_staged_sidecar_sha256"],
                         "AAF31C4BBD86BB553D69142643204236E84B665112ACE99BB43E717245421164")
        self.assertEqual(m["promotion"]["retrieval_utc"], m["last_attempt"]["started_utc"])
        self.assertNotEqual(m["promotion"]["promoted_utc"], m["promotion"]["retrieval_utc"])
        self.assertEqual(m["promotion"]["legacy_production_dataset_sha256"], LEGACY_PRODUCTION_SHA256)
        self.assertIn("exclude distributions", m["promotion"]["display_definition"])
        self.assertIn("not verified", m["promotion"]["latest_observation"])        # the Oct 1 claim is not upgraded
        self.assertTrue(m["historical_provenance"].startswith("unknown"))

    def test_fallback_on_promoted_copy_flags_no_possible_fill(self):
        shutil.copyfile(self.DS, self.ds)
        shutil.copyfile(self.SC, self.sc)
        res = self.run_(Fake(exc=TimeoutError("offline test")))
        self.assertEqual(res["exit_status"], st.EXIT_FAILED)
        flagged = [s for s, r in res["instruments"].items() if any("possible fill" in x for x in r["review_reasons"])]
        self.assertEqual(flagged, [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
