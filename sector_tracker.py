"""
sector_tracker.py - Kutun Terminal Stage 2D1
============================================
Sector-only ETF collector. It exists so sector history can be collected, validated and
staged WITHOUT running macro_engine.py (which also rewrites the event archive and the
news feed, and fills missing sector prices with ffill().bfill()).

What this module does and does not do
-------------------------------------
* Importing it performs no request and no write. It imports neither yfinance nor pandas
  (only the provider adapter does, lazily). It never exports macro events, never fetches
  news and never imports macro_engine.
* The downloader, output directory, clock and file writer are injectable.
  The CLI REQUIRES an explicit --output-dir and refuses a directory that looks like the
  application folder (contains index.html or app.js) unless --allow-app-directory is
  given. Stage 2D1 itself makes no provider request and replaces no production file.
* The frontend schema is unchanged:  { "<TICKER>": [ {"x": "YYYY-MM-DD", "y": price}, ... ] }

No fabricated observations (per ETF, independently)
---------------------------------------------------
Dates and prices are paired BEFORE sorting. Only actual, usable observations returned for
THAT ETF are kept. There is no forward fill, no backward fill, no interpolation and no
zero substitution, and no common artificial start date: an ETF's first returned
observation is a coverage boundary, not a verified inception date. Missing values
introduced by aligning several symbols in one table are removed, never turned into prices.
Removed rows are counted by kind (null, nan, infinite, non_numeric, non_positive) and by
position relative to the usable data (leading / internal / trailing) and disclosed.

REJECT THE WHOLE RESPONSE (the ETF is then retained or unavailable) when: it is not a
mapping; "dates"/"prices" are missing or not lists; the lengths differ; there are zero
rows or zero usable observations; any date is not a real ISO date, is duplicated, or is
after the as-of date (the supplied clock's UTC date; date validation is not proof that an
exchange session is complete); or the response's price field is not the requested one.
REMOVE INDIVIDUAL ROWS when the price is null, NaN, infinite, non-numeric (strings and
booleans are never coerced) or not strictly positive (ETF prices must be > 0). Prices are
rounded to 2 decimals as in the earlier collector and as stored in the dataset.

Price definition (initial price-return CANDIDATE configuration)
----------------------------------------------------------------
interval 1d, auto_adjust=False, price field "Close", start 2005-01-01, end = the as-of
date (provider end convention is not assumed to be inclusive). This is an unadjusted
provider Close. It is NOT claimed to be a dividend-inclusive total return, NOT claimed to
match the unknown settings that produced the historical production file, and the
provider's split/adjustment treatment is NOT independently verified. A series never
combines fields: a response whose price_field differs from the requested one is rejected.
The settings and dependency versions are recorded in the sidecar for later review.

Prior output, fallback and legacy coverage (sector-specific; differs from commodities)
--------------------------------------------------------------------------------------
If --output-dir already holds a dataset it is loaded as STRICT JSON before any request;
an unreadable/invalid one is never overwritten (exit 3). When an ETF's refresh fails its
usable prior series is RETAINED unchanged and labelled (retained_legacy_unverified, or
retained_prior_refresh_known when a hash-linked sidecar proves an earlier refresh time).
Unlike the commodity collector this module does NOT reject a clean candidate because it
drops older dates: the old production sector file contains suspected fabricated coverage
(identical leading values for XLRE and XLC). A valid candidate replaces the prior series
as a whole - prior dates are never merged back in - and every coverage loss (dates lost,
split into before/inside/after the candidate range, contiguous runs, first/last), start
later / end earlier, and every price revision on shared dates is recorded, with the
candidate marked review_required. Revision causes are not inferred. Nothing here
authorizes removing records from production; that needs a reviewed replacement step.

Outcomes / exit statuses
------------------------
  0  every ETF refreshed; dataset and sidecar written (review flags may still be set)
  1  unsuccessful: no ETF refreshed; the existing dataset is left byte-identical
  2  partial: dataset replaced, some ETFs retained or unavailable
  3  refused: existing dataset invalid, output directory missing, or app directory guard
  4  dataset replaced but the sidecar could not be written (mismatch detectable)
  5  dataset could not be serialised/written/verified/replaced; previous dataset kept
  6  --verify found the dataset and sidecar inconsistent
  7  command-line usage error

The dataset and the sidecar are two separate atomic replacements, not one transaction;
the sidecar carries the SHA-256 of the dataset bytes (py sector_tracker.py --verify
--output-dir DIR). Provenance recorded is only what the collector knew at run time;
older records are marked historical-provenance-unknown and are never given the current
settings or timestamps.
"""

import argparse
import os
import sys
from collections.abc import Mapping
from datetime import datetime, timezone

import commodity_tracker as ct   # shared primitives only (strict JSON, price kinds, atomic writer)

COLLECTOR_VERSION = "stage2d1_v1"
SIDECAR_SCHEMA = "sectors_meta_v1"
PROVIDER = "yfinance (Yahoo Finance)"
START_DATE = "2005-01-01"
DATASET_FILE = "sector_historical.json"
SIDECAR_FILE = "sector_historical_meta.json"
DOWNLOAD_TIMEOUT_S = ct.DOWNLOAD_TIMEOUT_S

# The 11 sector ETFs, unchanged from the earlier collector.
SECTOR_SYMBOLS = ["XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC"]

PRICE_FIELD = "Close"
INTERVAL = "1d"
AUTO_ADJUST = False
# Passed to the downloader as keyword arguments on every call and recorded in the sidecar.
REQUEST_OPTIONS = {"interval": INTERVAL, "auto_adjust": AUTO_ADJUST, "price_field": PRICE_FIELD}

PRICE_DEFINITION = {
    "description": "Unadjusted provider Close (price return CANDIDATE configuration), rounded to 2 decimals.",
    "interval": INTERVAL,
    "auto_adjust": "explicit: False",
    "price_field": "explicit: 'Close'",
    "not_claimed": [
        "dividend-inclusive total return",
        "equivalence with the unknown settings that produced the historical production file",
        "independently verified provider split/adjustment treatment",
        "that a first returned observation is the ETF's inception date",
    ],
}

EXIT_OK = ct.EXIT_OK
EXIT_FAILED = ct.EXIT_FAILED
EXIT_PARTIAL = ct.EXIT_PARTIAL
EXIT_REFUSED = ct.EXIT_REFUSED
EXIT_SIDECAR_FAILED = ct.EXIT_SIDECAR_FAILED
EXIT_WRITE_FAILED = ct.EXIT_WRITE_FAILED
EXIT_VERIFY_FAILED = ct.EXIT_VERIFY_FAILED
EXIT_USAGE = 7

REMOVAL_KINDS = ("null", "nan", "infinite", "non_numeric", "non_positive")
LEADING_RUN_WARN = 10          # leading identical values worth flagging as a possible fill (screen only)
MAX_RUNS_RECORDED = 20

WriteError = ct.WriteError
FileIO = ct.FileIO


def serialize_document(doc):
    """Strict JSON bytes (NaN/Infinity raise). Wrapper so tests can force failures."""
    return ct.serialize_document(doc)


def _utc_iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


# ---------------------------------------------------------------- validation --

def _gap_days(labels):
    best = 0
    for a, b in zip(labels, labels[1:]):
        best = max(best, (ct.parse_iso_date(b) - ct.parse_iso_date(a)).days)
    return best


def leading_identical_run(values):
    """Number of leading values equal to the first (screen for possible fill, not proof)."""
    if not values:
        return 0
    n = 1
    while n < len(values) and values[n] == values[0]:
        n += 1
    return n


def _coverage(labels, prices):
    return {"records": len(labels), "first": labels[0] if labels else None,
            "last": labels[-1] if labels else None,
            "max_gap_days": _gap_days(labels) if labels else None,
            "leading_identical_run": leading_identical_run(prices)}


def validate_candidate(response, as_of, price_field=PRICE_FIELD):
    """
    Validate ONE ETF's response. Returns {"ok", "reasons", "labels", "prices", "stats"};
    labels/prices are ascending, unique-dated, finite, positive and paired (when ok only).
    """
    out = {"ok": False, "reasons": [], "labels": [], "prices": [], "stats": {}}
    if not isinstance(response, Mapping):
        out["reasons"].append("response is not a mapping (got %s)" % type(response).__name__)
        return out
    missing = [k for k in ("dates", "prices") if k not in response]
    if missing:
        out["reasons"].append("missing required column(s): " + ", ".join(missing))
        return out
    dates, prices = response["dates"], response["prices"]
    if not isinstance(dates, (list, tuple)) or not isinstance(prices, (list, tuple)):
        out["reasons"].append("'dates' and 'prices' must be lists")
        return out
    if response.get("price_field") != price_field:
        out["reasons"].append("price field %r is not the requested %r (fields are never mixed)" % (
            response.get("price_field"), price_field))
        return out
    if len(dates) != len(prices):
        out["reasons"].append("unequal lengths: %d dates vs %d prices" % (len(dates), len(prices)))
        return out
    if len(dates) == 0:
        out["reasons"].append("empty response (0 rows)")
        return out

    invalid_dates, duplicates, future = [], [], []
    seen, rows = set(), []
    for d, p in zip(dates, prices):                     # pair first; sort later
        dd = ct.parse_iso_date(d)
        if dd is None:
            invalid_dates.append(repr(d)[:24])
            continue
        if d in seen:
            duplicates.append(d)
        seen.add(d)
        if dd > as_of:
            future.append(d)
        kind, val = ct.classify_price(p)
        if kind == "ok":
            rounded = round(val, 2)
            if val <= 0 or rounded <= 0:
                kind, val = "non_positive", None
            else:
                val = rounded
        rows.append((d, kind, val))

    if invalid_dates:
        out["reasons"].append("%d invalid date(s), e.g. %s" % (len(invalid_dates), ", ".join(invalid_dates[:3])))
    if duplicates:
        out["reasons"].append("%d duplicate date(s), e.g. %s" % (len(duplicates), ", ".join(duplicates[:3])))
    if future:
        out["reasons"].append("%d date(s) after as-of %s, e.g. %s" % (len(future), as_of.isoformat(), ", ".join(future[:3])))
    if out["reasons"]:
        out["stats"] = {"rows_received": len(dates)}
        return out

    ordered = sorted(rows, key=lambda r: r[0])
    ok_idx = [i for i, r in enumerate(ordered) if r[1] == "ok"]
    removed = {k: 0 for k in REMOVAL_KINDS}
    position = {"leading": 0, "internal": 0, "trailing": 0}
    for i, (_d, kind, _v) in enumerate(ordered):
        if kind == "ok":
            continue
        removed[kind] += 1
        if not ok_idx or i < ok_idx[0]:
            position["leading"] += 1
        elif i > ok_idx[-1]:
            position["trailing"] += 1
        else:
            position["internal"] += 1
    labels = [ordered[i][0] for i in ok_idx]
    vals = [ordered[i][2] for i in ok_idx]
    removed_total = sum(removed.values())
    stats = {
        "rows_received": len(dates),
        "removed_rows": removed,
        "removed_total": removed_total,
        "removed_position": position,
        "reordered": [r[0] for r in rows] != [r[0] for r in ordered],
        "usable_observations": len(labels),
        "first": labels[0] if labels else None,
        "last": labels[-1] if labels else None,
        "max_gap_days": _gap_days(labels) if labels else None,
        "price_field": response.get("price_field"),
        "warnings": [],
    }
    out["stats"] = stats
    if not labels:
        out["reasons"].append("no usable observations (%d row(s) removed: %s)" % (
            removed_total, ", ".join("%s=%d" % kv for kv in removed.items() if kv[1])))
        return out
    if len(labels) == 1:
        stats["warnings"].append("single usable observation")
    if removed_total:
        stats["warnings"].append(
            "%d row(s) removed, none filled (leading %d, internal %d, trailing %d); leading/trailing "
            "removals are expected for a late-starting ETF or multi-symbol alignment" % (
                removed_total, position["leading"], position["internal"], position["trailing"]))
    if position["internal"]:
        stats["warnings"].append("%d internal missing price(s) left as gaps" % position["internal"])
    run = leading_identical_run(vals)
    if run >= LEADING_RUN_WARN:
        stats["warnings"].append("first %d usable prices are identical (possible fill by the provider; screen, not proof)" % run)
    out.update(ok=True, labels=labels, prices=vals)
    return out


def check_previous_points(entry):
    """Return ({date: price}, None) for a usable saved series, else (None, reason)."""
    if not isinstance(entry, list):
        return None, "entry is not a list"
    if not entry:
        return None, "no records"
    out = {}
    for pt in entry:
        if not isinstance(pt, dict) or "x" not in pt or "y" not in pt:
            return None, "point without x/y"
        d = pt["x"]
        if ct.parse_iso_date(d) is None:
            return None, "invalid date %r" % (d,)
        if d in out:
            return None, "duplicate date %s" % d
        kind, val = ct.classify_price(pt["y"])
        if kind != "ok" or val <= 0:
            return None, "invalid price (%s) on %s" % (kind if kind != "ok" else "non_positive", d)
        out[d] = val
    return out, None


def compare_with_prior(prev, labels, prices):
    """
    Describe how a valid clean candidate differs from the prior series. This NEVER rejects
    the candidate and NEVER merges prior dates back in. prev: {date: price}.
    """
    cand = dict(zip(labels, prices))
    first, last = labels[0], labels[-1]
    prev_dates = sorted(prev)
    lost = [d for d in prev_dates if d not in cand]
    lost_set = set(lost)
    runs, cur = [], None
    for d in prev_dates:                       # contiguous runs in the PRIOR date sequence
        if d in lost_set:
            if cur is None:
                cur = [d, d, 1]
            else:
                cur[1], cur[2] = d, cur[2] + 1
        elif cur is not None:
            runs.append(cur)
            cur = None
    if cur is not None:
        runs.append(cur)
    added = [d for d in labels if d not in prev]
    shared = [d for d in prev_dates if d in cand]
    changed = [d for d in shared if cand[d] != prev[d]]
    rel = [abs(cand[d] - prev[d]) / abs(prev[d]) for d in changed if prev[d] != 0]
    info = {
        "prior": {"records": len(prev), "first": prev_dates[0], "last": prev_dates[-1],
                  "leading_identical_run": leading_identical_run([prev[d] for d in prev_dates])},
        "dates_lost": {
            "count": len(lost), "first": lost[0] if lost else None, "last": lost[-1] if lost else None,
            "before_candidate_first": sum(1 for d in lost if d < first),
            "inside_candidate_range": sum(1 for d in lost if first <= d <= last),
            "after_candidate_last": sum(1 for d in lost if d > last),
            "runs": [{"first": r[0], "last": r[1], "count": r[2]} for r in runs[:MAX_RUNS_RECORDED]],
            "runs_truncated": len(runs) > MAX_RUNS_RECORDED,
        },
        "dates_added": {"count": len(added), "first": added[0] if added else None,
                        "last": added[-1] if added else None},
        "starts_later": first > prev_dates[0],
        "ends_earlier": last < prev_dates[-1],
        "revisions": {
            "shared_dates": len(shared), "revised_dates": len(changed),
            "first_revised": changed[0] if changed else None,
            "last_revised": changed[-1] if changed else None,
            "max_abs_change": max((abs(cand[d] - prev[d]) for d in changed), default=None),
            "max_rel_change": max(rel, default=None),
            "cause": "not inferred",
        },
    }
    reasons = []
    if lost:
        reasons.append("candidate does not contain %d prior date(s) (first %s, last %s; %d before the candidate "
                       "start, %d inside its range, %d after its end); prior records may include fabricated "
                       "fill - review before any production use" % (
                           len(lost), lost[0], lost[-1], info["dates_lost"]["before_candidate_first"],
                           info["dates_lost"]["inside_candidate_range"], info["dates_lost"]["after_candidate_last"]))
    if info["starts_later"]:
        reasons.append("candidate starts later (%s) than prior history (%s)" % (first, prev_dates[0]))
    if info["ends_earlier"]:
        reasons.append("candidate ends earlier (%s) than prior history (%s)" % (last, prev_dates[-1]))
    if changed:
        reasons.append("%d shared date(s) have different prices (max abs %s); cause not inferred" % (
            len(changed), info["revisions"]["max_abs_change"]))
    return info, reasons


# ------------------------------------------------------------ file handling --

def load_prior_sidecar(path):
    try:
        with open(path, "rb") as fh:
            doc = ct.strict_loads(fh.read())
    except Exception:
        return None
    return doc if isinstance(doc, dict) and doc.get("schema") == SIDECAR_SCHEMA else None


def verify_consistency(dataset_path, sidecar_path):
    """Detect a dataset/sidecar mismatch (read-only). Returns {"status", "detail"}."""
    if not os.path.exists(dataset_path):
        return {"status": "dataset_missing", "detail": dataset_path}
    side = load_prior_sidecar(sidecar_path)
    if side is None:
        return {"status": "sidecar_missing_or_invalid", "detail": sidecar_path}
    with open(dataset_path, "rb") as fh:
        actual = ct.sha256_hex(fh.read())
    if side.get("dataset_sha256") != actual:
        return {"status": "dataset_hash_mismatch",
                "detail": "sidecar %s vs dataset %s" % (side.get("dataset_sha256"), actual)}
    return {"status": "consistent", "detail": actual}


def _verify_dataset_bytes(raw, candidate):
    if ct.strict_loads(raw) != candidate:
        raise WriteError("re-read dataset differs from the candidate")


# ------------------------------------------------------------------ refresh --

def run_refresh(downloader, output_dir, dataset_file=DATASET_FILE, sidecar_file=SIDECAR_FILE,
                clock=None, io=None, symbols=None, start_date=START_DATE, dependencies=None,
                log=print, request_options=None):
    """
    One refresh attempt. downloader(symbols, start, end, **request_options) ->
    Mapping[symbol -> {"dates": [...], "prices": [...], "price_field": "Close"}]; a value that
    is an Exception (or a missing/None symbol) is a per-ETF failure; an exception raised by
    the downloader (including TimeoutError) fails every ETF. Returns a result dict with
    exit_status. output_dir has no default on purpose.
    """
    clock = clock or (lambda: datetime.now(timezone.utc))
    io = io or FileIO()
    syms = list(symbols or SECTOR_SYMBOLS)
    options = dict(REQUEST_OPTIONS if request_options is None else request_options)
    dataset_path = os.path.join(output_dir, dataset_file)
    sidecar_path = os.path.join(output_dir, sidecar_file)
    started = clock()
    as_of = started.astimezone(timezone.utc).date()
    end_date = as_of.isoformat()
    result = {"exit_status": EXIT_FAILED, "outcome": "failed", "dataset_replaced": False,
              "instruments": {}, "sidecar_written": False, "sidecar_error": None,
              "dataset_error": None, "dataset_sha256": None, "as_of": end_date,
              "review_required": False}

    # 1. Load and validate the existing dataset BEFORE any request.
    status, prior, prior_raw, why = ct.load_previous(dataset_path)
    if status == "invalid":
        result.update(exit_status=EXIT_REFUSED, outcome="refused", dataset_error=why)
        log("REFUSED: existing %s is unreadable or invalid (%s). Nothing requested or written." % (dataset_file, why))
        return result
    prior_hash = ct.sha256_hex(prior_raw) if prior_raw is not None else None
    prior_side = load_prior_sidecar(sidecar_path)
    prior_side_valid = bool(prior_side and prior_hash and prior_side.get("dataset_sha256") == prior_hash)
    prior_known = (prior_side or {}).get("instruments") if prior_side_valid else {}
    prior_known = prior_known if isinstance(prior_known, dict) else {}

    # 2. Request (the real provider call lives only in the injected downloader).
    responses, batch_error = {}, None
    try:
        responses = downloader(list(syms), start_date, end_date, **options)
        if not isinstance(responses, Mapping):
            batch_error = "downloader returned %s, not a mapping" % type(responses).__name__
            responses = {}
    except Exception as exc:
        batch_error = "%s: %s" % (type(exc).__name__, exc)
        responses = {}

    # 3. Validate each ETF independently and decide refreshed / retained / unavailable.
    candidate = {}
    for sym in syms:
        rec = {"symbol": sym, "status": None, "provenance": None, "reasons": [], "price_field": None,
               "attempt": None, "coverage": None, "comparison_with_prior": None,
               "review_required": False, "review_reasons": [],
               "last_successful_refresh_utc": None, "last_successful_refresh_known": False}
        result["instruments"][sym] = rec
        prev_entry = prior.get(sym)
        prev_map, prev_why = (check_previous_points(prev_entry) if sym in prior else (None, "no saved series"))

        resp = None
        if batch_error:
            rec["reasons"].append("download failed: " + batch_error)
        elif sym not in responses or responses[sym] is None:
            rec["reasons"].append("no response for symbol %s" % sym)
        elif isinstance(responses[sym], BaseException):
            exc = responses[sym]
            rec["reasons"].append("provider error: %s: %s" % (type(exc).__name__, exc))
        else:
            resp = responses[sym]

        accepted = None
        if resp is not None:
            v = validate_candidate(resp, as_of, options.get("price_field", PRICE_FIELD))
            rec["attempt"] = v["stats"] or None
            if v["ok"]:
                accepted = v
            else:
                rec["reasons"].extend("response rejected: " + r for r in v["reasons"])

        known = prior_known.get(sym) if isinstance(prior_known.get(sym), dict) else {}
        if accepted is not None:
            rec.update(status="refreshed", provenance="refreshed_this_attempt",
                       price_field=accepted["stats"].get("price_field"),
                       last_successful_refresh_utc=_utc_iso(started), last_successful_refresh_known=True)
            rec["coverage"] = _coverage(accepted["labels"], accepted["prices"])
            candidate[sym] = [{"x": d, "y": p} for d, p in zip(accepted["labels"], accepted["prices"])]
            if prev_map is not None:
                info, why_review = compare_with_prior(prev_map, accepted["labels"], accepted["prices"])
                rec["comparison_with_prior"] = info
                rec["review_reasons"].extend(why_review)
            elif sym in prior:
                rec["reasons"].append("saved series was unusable (%s); replaced by the validated candidate" % prev_why)
                rec["review_reasons"].append("replaced an unusable saved series (%s)" % prev_why)
        else:
            rec["last_successful_refresh_utc"] = known.get("last_successful_refresh_utc")
            rec["last_successful_refresh_known"] = bool(known.get("last_successful_refresh_known")
                                                        and rec["last_successful_refresh_utc"])
            rec["price_field"] = known.get("price_field")
            if prev_map is not None:
                labels_sorted = sorted(prev_map)
                rec["status"] = "retained"
                rec["coverage"] = _coverage(labels_sorted, [prev_map[d] for d in labels_sorted])
                candidate[sym] = prev_entry
                if rec["last_successful_refresh_known"]:
                    rec["provenance"] = "retained_prior_refresh_known"
                else:
                    rec["provenance"] = "retained_legacy_unverified"
                    rec["review_reasons"].append(
                        "retained legacy series with unverified historical provenance (price definition, "
                        "retrieval time and any fill unknown); not refreshed in this attempt")
                    run = rec["coverage"]["leading_identical_run"]
                    if run >= LEADING_RUN_WARN:
                        rec["review_reasons"].append(
                            "retained series starts with %d identical prices (possible fill; screen, not proof)" % run)
            elif sym in prior:
                rec.update(status="unavailable", provenance="saved_series_unusable")
                rec["reasons"].append("previous series unusable (%s); carried over unchanged, not validated" % prev_why)
                rec["review_reasons"].append("saved series unusable (%s)" % prev_why)
                candidate[sym] = prev_entry
            else:
                rec.update(status="unavailable", provenance="none")
                rec["reasons"].append("no usable previous series")
        rec["review_required"] = bool(rec["review_reasons"])

    for sym, entry in prior.items():            # saved tickers this collector does not request
        if sym not in syms:
            candidate[sym] = entry
            result["instruments"][sym] = {
                "symbol": None, "status": "not_requested_retained", "provenance": "retained_legacy_unverified",
                "reasons": ["not in SECTOR_SYMBOLS; carried over unchanged"], "coverage": None, "attempt": None,
                "comparison_with_prior": None, "review_required": True,
                "review_reasons": ["ticker not requested by this collector; unverified legacy data carried over"],
                "last_successful_refresh_utc": None, "last_successful_refresh_known": False, "price_field": None}

    requested = [result["instruments"][s] for s in syms]
    refreshed = [r for r in requested if r["status"] == "refreshed"]
    result["counts"] = {"requested": len(requested), "refreshed": len(refreshed),
                        "retained": sum(1 for r in requested if r["status"] == "retained"),
                        "unavailable": sum(1 for r in requested if r["status"] == "unavailable")}
    result["review_required"] = any(r["review_required"] for r in result["instruments"].values())

    # 4. Write the dataset only if at least one ETF was refreshed.
    on_disk_hash = prior_hash
    if not refreshed:
        result.update(exit_status=EXIT_FAILED, outcome="failed")
        log("UNSUCCESSFUL REFRESH: no ETF was refreshed; %s left unchanged." % dataset_file)
    else:
        ordered = {s: candidate[s] for s in syms if s in candidate}
        ordered.update({k: v for k, v in candidate.items() if k not in ordered})
        try:
            payload = serialize_document(ordered)
        except Exception as exc:
            payload, result["dataset_error"] = None, "serialization failed: %s: %s" % (type(exc).__name__, exc)
        if payload is not None:
            try:
                io.write_atomic(dataset_path, payload, verify=lambda raw: _verify_dataset_bytes(raw, ordered))
                result["dataset_replaced"] = True
                on_disk_hash = ct.sha256_hex(payload)
            except WriteError as exc:
                result["dataset_error"] = "write failed: %s" % exc
        if result["dataset_replaced"]:
            full = result["counts"]["refreshed"] == result["counts"]["requested"]
            result.update(exit_status=EXIT_OK if full else EXIT_PARTIAL, outcome="success" if full else "partial")
        else:
            result.update(exit_status=EXIT_WRITE_FAILED, outcome="write_failed")
            log("WRITE FAILED (%s); previous %s preserved." % (result["dataset_error"], dataset_file))
    result["dataset_sha256"] = on_disk_hash

    # 5. Sidecar (a separate write; not one transaction with the dataset).
    completed = clock()
    sidecar = {
        "schema": SIDECAR_SCHEMA,
        "collector": "sector_tracker.py",
        "collector_version": COLLECTOR_VERSION,
        "dataset_file": dataset_file,
        "dataset_sha256": on_disk_hash,
        "dataset_replaced_by_this_attempt": result["dataset_replaced"],
        "atomicity_note": "Dataset and sidecar are written as two separate atomic file replacements, not one "
                          "transaction. Compare dataset_sha256 with the dataset (py sector_tracker.py --verify "
                          "--output-dir DIR).",
        "provider": PROVIDER,
        "request": {"start": start_date, "end": end_date,
                    "end_convention": "passed to the provider as given; not assumed inclusive",
                    "interval": options.get("interval"),
                    "auto_adjust": "explicit: %r" % options.get("auto_adjust"),
                    "price_field": "explicit: %r" % options.get("price_field"),
                    "download_options": options, "timeout_seconds": DOWNLOAD_TIMEOUT_S,
                    "as_of_utc_date": end_date, "symbols": list(syms)},
        "price_definition": PRICE_DEFINITION,
        "fill_policy": "none: no forward fill, backward fill, interpolation, zero substitution or common start date",
        "dependencies": dependencies if dependencies is not None else ct.dependency_versions(),
        "last_attempt": {"started_utc": _utc_iso(started), "completed_utc": _utc_iso(completed),
                         "outcome": result["outcome"], "exit_status": result["exit_status"],
                         "batch_error": batch_error, "dataset_error": result["dataset_error"],
                         "counts": result["counts"]},
        "review": {"required_before_production_use": result["review_required"],
                   "instruments": [n for n, r in result["instruments"].items() if r["review_required"]]},
        "historical_provenance": "unknown for any record not listed as refreshed with a last_successful_refresh_utc "
                                 "by a sidecar-writing run; no provider, symbol, price field, adjustment or time is "
                                 "attributed to older or retained records",
        "instruments": result["instruments"],
    }
    try:
        io.write_atomic(sidecar_path, serialize_document(sidecar), verify=lambda raw: ct.strict_loads(raw))
        result["sidecar_written"] = True
    except Exception as exc:
        result["sidecar_error"] = "%s: %s" % (type(exc).__name__, exc)
        log("WARNING: sidecar not written (%s)." % result["sidecar_error"])
        if result["dataset_replaced"]:
            result["exit_status"] = EXIT_SIDECAR_FAILED
            result["outcome"] += "+sidecar_failed"
            log("Dataset was replaced but its sidecar is stale or missing; run --verify.")
    _print_summary(result, log)
    return result


def _print_summary(result, log):
    for name, rec in result["instruments"].items():
        cov = rec.get("coverage") or {}
        line = "  %-6s %-22s" % (name, rec["status"])
        if cov:
            line += " %s records %s..%s" % (cov["records"], cov["first"], cov["last"])
        log(line)
        for r in rec["reasons"]:
            log("      - " + r)
        for r in rec.get("review_reasons") or []:
            log("      ! REVIEW: " + r)
    if result["review_required"]:
        log("REVIEW REQUIRED before any production use of this output (see sidecar 'review').")
    log("Outcome: %s (exit %d); dataset replaced: %s; sidecar written: %s" % (
        result["outcome"], result["exit_status"], result["dataset_replaced"], result["sidecar_written"]))


# ------------------------------------------------------- real provider adapter --

def yfinance_downloader(symbols, start, end, interval=INTERVAL, auto_adjust=AUTO_ADJUST, price_field=PRICE_FIELD):
    """
    The only function that touches the provider (imported lazily; offline tests stub the
    module). All options are explicit. Several symbols come back in one table, so rows
    where another ETF traded but this one did not arrive as NaN; they are passed through
    for validation to count and remove - never filled.
    """
    import inspect
    import yfinance as yf
    kwargs = {"interval": interval, "auto_adjust": bool(auto_adjust)}
    try:
        if "timeout" in inspect.signature(yf.download).parameters:
            kwargs["timeout"] = DOWNLOAD_TIMEOUT_S
    except (TypeError, ValueError):
        pass
    frame = yf.download(list(symbols), start=start, end=end, **kwargs)
    return ct.frame_to_responses(frame, list(symbols), price_field=price_field)


# ----------------------------------------------------------------------- CLI --

class _Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(EXIT_USAGE)


def build_parser():
    p = _Parser(prog="sector_tracker.py",
                description="Sector-only ETF collector (no events, no news). Requires an explicit output directory.")
    p.add_argument("--output-dir", required=True,
                   help="directory that holds / will receive %s and %s (required; use a staging copy)" % (
                       DATASET_FILE, SIDECAR_FILE))
    p.add_argument("--verify", action="store_true",
                   help="offline: check the dataset against its sidecar hash; no download, no write")
    p.add_argument("--allow-app-directory", action="store_true",
                   help="permit an output directory that contains index.html or app.js (the application folder)")
    return p


def main(argv=None, downloader=None, clock=None, io=None, log=print):
    args = build_parser().parse_args(argv)
    out_dir = args.output_dir
    if args.verify:
        res = verify_consistency(os.path.join(out_dir, DATASET_FILE), os.path.join(out_dir, SIDECAR_FILE))
        log("%s: %s" % (res["status"], res["detail"]))
        return EXIT_OK if res["status"] == "consistent" else EXIT_VERIFY_FAILED
    if not os.path.isdir(out_dir):
        log("REFUSED: output directory %r does not exist. Nothing requested or written." % out_dir)
        return EXIT_REFUSED
    if not args.allow_app_directory and any(os.path.exists(os.path.join(out_dir, f)) for f in ("index.html", "app.js")):
        log("REFUSED: %r looks like the application folder (index.html/app.js present). Use a staging directory, "
            "or pass --allow-app-directory in a reviewed production step. Nothing requested or written." % out_dir)
        return EXIT_REFUSED
    log("Fetching %d sector ETFs from %s (provider: %s; %s)..." % (
        len(SECTOR_SYMBOLS), START_DATE, PROVIDER, ", ".join("%s=%r" % kv for kv in REQUEST_OPTIONS.items())))
    result = run_refresh(downloader or yfinance_downloader, out_dir, clock=clock, io=io, log=log)
    return result["exit_status"]


if __name__ == "__main__":
    sys.exit(main())
