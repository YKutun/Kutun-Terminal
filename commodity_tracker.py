"""
commodity_tracker.py - Kutun Terminal Stage 2B
==============================================
Commodity collector with failure safety: prior usable history is preserved when a
download or a write fails.

What this module guarantees (all exercised by tests/test_commodity_tracker.py with
fake downloaders and temporary directories; no provider request is made by tests)
-------------------------------------------------------------------------------
* Importing it performs no download, no write and imports neither yfinance nor
  pandas. Work happens only in main()/run_refresh(), behind a main guard. The
  downloader, output directory, clock and file writer can all be supplied.
* The frontend dataset schema is unchanged:
      { "<Name>": { "labels": ["YYYY-MM-DD", ...], "prices": [float, ...] }, ... }
* The existing dataset is loaded and validated BEFORE any request. If it exists but
  is unreadable or structurally invalid, nothing is requested or written (exit 3).
* Every candidate series is validated, then compared with the saved series; failures
  keep the previous series (see "Validation" and "History preservation").
* The dataset is written as strict JSON (NaN/Infinity cannot be serialised) to a
  temporary file in the destination directory, re-read, verified, then os.replace()d.
  On any failure the previous dataset is untouched.
* A provenance sidecar (commodities_data_meta.json) is written AFTER the dataset. The
  two files are NOT one atomic transaction; the sidecar carries the SHA-256 of the
  dataset bytes so a mismatch is detectable (py commodity_tracker.py --verify).

Validation (per instrument)
---------------------------
REJECT THE WHOLE RESPONSE (the previous series is retained) when:
  - the response is not a mapping, lacks "dates" or "prices", or they are not lists;
  - the lists have different lengths (pairing would be ambiguous);
  - there are zero rows, or zero usable observations after row removal;
  - any date is not a real ISO calendar date (YYYY-MM-DD), any date is duplicated,
    or any date is after the as-of date (the supplied clock's UTC date);
  - it fails the history-preservation comparison below.
REMOVE INDIVIDUAL ROWS (counted by kind and disclosed in the sidecar) when the price
is null, NaN, infinite or non-numeric (including numeric strings and booleans; there
is no coercion). Nothing is filled, interpolated or fabricated. Rows are re-sorted by
date with prices kept paired (disclosed as "reordered"). Zero and negative FINITE
prices are valid collector data (e.g. the legitimate negative WTI observation); whether
a percentage return is computable is a separate, frontend decision. Prices are rounded
to 2 decimals as before.

History preservation (full-history collector, conservative rule - not proof that any
saved observation is correct)
---------------------------------------------------------------------------------
A candidate is REJECTED when, compared with a usable saved series, it drops any
previously stored date, starts later, or ends earlier. Accepted candidates that change
prices on shared dates are accepted as a whole and the revisions (count, first/last
revised date, maximum absolute and relative change) are recorded; their cause is not
inferred and no adjustment setting is changed. Revised history is never merged
silently. A saved series that is itself unusable is not overwritten by a failed
candidate (it is carried over unchanged and reported); a valid candidate may replace it.

Exit statuses
-------------
  0  every requested instrument refreshed; dataset and sidecar written
  1  UNSUCCESSFUL refresh: no instrument refreshed; dataset left byte-identical
  2  partial: dataset replaced, but some instruments were retained or unavailable
  3  refused: existing dataset unreadable/invalid; nothing written
  4  dataset replaced but the sidecar could not be written (hash mismatch detectable)
  5  candidate could not be serialised/written/verified/replaced; previous dataset kept
  6  --verify found the dataset and sidecar inconsistent (or missing)

Provenance facts recorded are only those available to the collector at run time.
Existing data without metadata is marked historical-provenance-unknown; current
settings and timestamps are never attributed to older records.
"""

import argparse
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from collections.abc import Mapping
from datetime import date, datetime, timezone

COLLECTOR_VERSION = "stage2b_v1"
SIDECAR_SCHEMA = "commodities_meta_v1"
PROVIDER = "yfinance (Yahoo Finance)"
START_DATE = "2005-01-01"
DATASET_FILE = "commodities_data.json"
SIDECAR_FILE = "commodities_data_meta.json"
DOWNLOAD_TIMEOUT_S = 30

# Display name -> Yahoo ticker. Unchanged from the previous collector (symbols are not
# altered in this checkpoint).
COMMODITY_MAP = {
    "Gold": "GC=F",
    "Silver": "SI=F",
    "Platinum": "PL=F",
    "Palladium": "PA=F",
    "Copper": "HG=F",
    "Soybeans": "ZS=F",
    "Brent Crude": "BZ=F",
    "WTI Crude": "CL=F",
    "Natural Gas": "NG=F",
    "Cocoa": "CC=F",
    "Lumber": "LBS=F",
    "Sugar": "SB=F",
    "Corn": "ZC=F",
    "Wheat": "ZW=F",
}

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_PARTIAL = 2
EXIT_REFUSED = 3
EXIT_SIDECAR_FAILED = 4
EXIT_WRITE_FAILED = 5
EXIT_VERIFY_FAILED = 6

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class WriteError(Exception):
    """A dataset/sidecar could not be serialised, written, verified or replaced."""


# ---------------------------------------------------------------- primitives --

def parse_iso_date(value):
    """Strict YYYY-MM-DD real calendar date, else None."""
    if not isinstance(value, str) or not _ISO.match(value):
        return None
    try:
        return date(int(value[0:4]), int(value[5:7]), int(value[8:10]))
    except ValueError:
        return None


def classify_price(value):
    """Return (kind, float|None); kind in ok|null|nan|infinite|non_numeric."""
    if value is None:
        return "null", None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "non_numeric", None
    try:
        f = float(value)
    except OverflowError:
        return "infinite", None
    if math.isnan(f):
        return "nan", None
    if math.isinf(f):
        return "infinite", None
    return "ok", f


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def _reject_constant(name):
    raise ValueError("non-standard JSON constant %s" % name)


def _no_duplicate_keys(pairs):
    d = {}
    for k, v in pairs:
        if k in d:
            raise ValueError("duplicate JSON key %r" % k)
        d[k] = v
    return d


def strict_loads(raw):
    """Strict JSON parse of bytes: no NaN/Infinity tokens, no duplicate keys."""
    return json.loads(raw.decode("utf-8"), parse_constant=_reject_constant,
                      object_pairs_hook=_no_duplicate_keys)


def serialize_document(doc):
    """Strict JSON bytes (allow_nan=False: NaN/Infinity raise ValueError)."""
    return json.dumps(doc, indent=2, allow_nan=False).encode("utf-8")


# ---------------------------------------------------------------- validation --

def validate_candidate(response, as_of):
    """
    Validate one instrument's downloaded response.
    Returns {"ok", "reasons", "labels", "prices", "stats"}; labels/prices are
    ascending, unique-dated, finite and paired (only when ok).
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
    if len(dates) != len(prices):
        out["reasons"].append("unequal lengths: %d dates vs %d prices" % (len(dates), len(prices)))
        return out
    if len(dates) == 0:
        out["reasons"].append("empty response (0 rows)")
        return out

    removed = {"null": 0, "nan": 0, "infinite": 0, "non_numeric": 0}
    invalid_dates, duplicates, future = [], [], []
    seen = set()
    rows = []
    for d, p in zip(dates, prices):
        dd = parse_iso_date(d)
        if dd is None:
            invalid_dates.append(repr(d)[:24])
            continue
        if d in seen:
            duplicates.append(d)
        seen.add(d)
        if dd > as_of:
            future.append(d)
        kind, val = classify_price(p)
        if kind != "ok":
            removed[kind] += 1
            continue
        rows.append((d, round(val, 2)))

    if invalid_dates:
        out["reasons"].append("%d invalid date(s), e.g. %s" % (len(invalid_dates), ", ".join(invalid_dates[:3])))
    if duplicates:
        out["reasons"].append("%d duplicate date(s), e.g. %s" % (len(duplicates), ", ".join(duplicates[:3])))
    if future:
        out["reasons"].append("%d date(s) after as-of %s, e.g. %s" % (len(future), as_of.isoformat(), ", ".join(future[:3])))
    ordered = sorted(rows, key=lambda r: r[0])
    stats = {
        "rows_received": len(dates),
        "removed_rows": dict(removed),
        "removed_total": sum(removed.values()),
        "reordered": ordered != rows,
        "usable_observations": len(ordered),
        "first": ordered[0][0] if ordered else None,
        "last": ordered[-1][0] if ordered else None,
        "zero_prices": sum(1 for _, p in ordered if p == 0),
        "negative_prices": sum(1 for _, p in ordered if p < 0),
        "warnings": [],
        "price_field": response.get("price_field") if isinstance(response.get("price_field"), str) else None,
    }
    out["stats"] = stats
    if not ordered and not (invalid_dates or duplicates or future):
        out["reasons"].append("no usable observations (%d row(s) removed: %s)" % (
            stats["removed_total"], ", ".join("%s=%d" % kv for kv in removed.items() if kv[1])))
    if out["reasons"]:
        return out
    if len(ordered) == 1:
        stats["warnings"].append("single usable observation")
    if stats["removed_total"]:
        stats["warnings"].append("%d row(s) removed for invalid prices" % stats["removed_total"])
    out["ok"] = True
    out["labels"] = [r[0] for r in ordered]
    out["prices"] = [r[1] for r in ordered]
    return out


def check_previous_series(entry):
    """Return ({date: price}, None) for a usable saved series, else (None, reason)."""
    if not isinstance(entry, dict):
        return None, "entry is not an object"
    labels, prices = entry.get("labels"), entry.get("prices")
    if not isinstance(labels, list) or not isinstance(prices, list):
        return None, "labels/prices missing or not lists"
    if len(labels) != len(prices):
        return None, "labels and prices have different lengths (%d vs %d)" % (len(labels), len(prices))
    if not labels:
        return None, "no records"
    out = {}
    for d, p in zip(labels, prices):
        if parse_iso_date(d) is None:
            return None, "invalid date %r" % (d,)
        if d in out:
            return None, "duplicate date %s" % d
        kind, val = classify_price(p)
        if kind != "ok":
            return None, "invalid price (%s) on %s" % (kind, d)
        out[d] = val
    return out, None


def compare_with_previous(prev, labels, prices):
    """
    History-preservation comparison. prev: {date: price}. Returns
    {"ok", "reasons", "revisions"}; rejects dropped dates / later start / earlier end.
    """
    cand = dict(zip(labels, prices))
    reasons = []
    dropped = sorted(d for d in prev if d not in cand)
    if dropped:
        reasons.append("drops %d previously stored date(s) (first %s, last %s)" % (len(dropped), dropped[0], dropped[-1]))
    if min(cand) > min(prev):
        reasons.append("starts later (%s) than saved history (%s)" % (min(cand), min(prev)))
    if max(cand) < max(prev):
        reasons.append("ends earlier (%s) than saved history (%s)" % (max(cand), max(prev)))
    shared = [d for d in prev if d in cand]
    changed = [d for d in shared if cand[d] != prev[d]]
    rel = [abs(cand[d] - prev[d]) / abs(prev[d]) for d in changed if prev[d] != 0]
    revisions = {
        "shared_dates": len(shared),
        "revised_dates": len(changed),
        "first_revised": min(changed) if changed else None,
        "last_revised": max(changed) if changed else None,
        "max_abs_change": max((abs(cand[d] - prev[d]) for d in changed), default=None),
        "max_rel_change": max(rel, default=None),
        "cause": "not inferred",
    }
    return {"ok": not reasons, "reasons": reasons, "revisions": revisions}


def _coverage(labels):
    return {"records": len(labels), "first": labels[0] if labels else None,
            "last": labels[-1] if labels else None}


# ------------------------------------------------------------ file handling --

class FileIO:
    """Atomic file writer; the pieces are injectable so tests can force failures."""

    def __init__(self, replace=os.replace, temp_factory=tempfile.mkstemp, fsync=os.fsync):
        self.replace = replace
        self.temp_factory = temp_factory
        self.fsync = fsync

    def write_atomic(self, path, payload, verify=None):
        """
        Write payload to a temporary file in the destination directory, flush, re-read,
        verify, then replace the destination. The destination is changed only by the
        final replace. Raises WriteError (temp file removed best-effort).
        """
        directory = os.path.dirname(os.path.abspath(path))
        tmp = None
        try:
            fd, tmp = self.temp_factory(dir=directory, prefix=os.path.basename(path) + ".", suffix=".tmp")
            with os.fdopen(fd, "wb") as fh:
                fh.write(payload)
                fh.flush()
                self.fsync(fh.fileno())
            with open(tmp, "rb") as fh:
                written = fh.read()
            if written != payload:
                raise WriteError("temporary file content differs from payload")
            if verify is not None:
                verify(written)
            self.replace(tmp, path)
            tmp = None
        except WriteError:
            raise
        except Exception as exc:
            raise WriteError("%s: %s" % (type(exc).__name__, exc)) from exc
        finally:
            if tmp is not None:
                try:
                    os.remove(tmp)
                except OSError:
                    pass


def load_previous(path):
    """
    Returns (status, data, raw_bytes, reason). status: 'missing' | 'ok' | 'invalid'.
    'invalid' = exists but unreadable, not strict JSON, or not an object: never overwritten.
    """
    if not os.path.exists(path):
        return "missing", {}, None, None
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
        data = strict_loads(raw)
    except Exception as exc:
        return "invalid", None, None, "%s: %s" % (type(exc).__name__, exc)
    if not isinstance(data, dict):
        return "invalid", None, raw, "top level is %s, not an object" % type(data).__name__
    return "ok", data, raw, None


def load_previous_sidecar(path):
    try:
        with open(path, "rb") as fh:
            doc = strict_loads(fh.read())
    except Exception:
        return None
    return doc if isinstance(doc, dict) and doc.get("schema") == SIDECAR_SCHEMA else None


def verify_consistency(dataset_path, sidecar_path):
    """Detect a dataset/sidecar mismatch. Returns {"status", "detail"}."""
    if not os.path.exists(dataset_path):
        return {"status": "dataset_missing", "detail": dataset_path}
    side = load_previous_sidecar(sidecar_path)
    if side is None:
        return {"status": "sidecar_missing_or_invalid", "detail": sidecar_path}
    with open(dataset_path, "rb") as fh:
        actual = sha256_hex(fh.read())
    if side.get("dataset_sha256") != actual:
        return {"status": "dataset_hash_mismatch",
                "detail": "sidecar %s vs dataset %s" % (side.get("dataset_sha256"), actual)}
    return {"status": "consistent", "detail": actual}


def dependency_versions():
    """Installed versions from package metadata only (no import of the packages)."""
    import importlib.metadata as md
    out = {"python": sys.version.split()[0]}
    for pkg in ("yfinance", "pandas", "numpy"):
        try:
            out[pkg] = md.version(pkg)
        except Exception:
            out[pkg] = None
    return out


# ------------------------------------------------------------------ refresh --

def _utc_iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


def run_refresh(downloader, output_dir=".", dataset_file=DATASET_FILE, sidecar_file=SIDECAR_FILE,
                clock=None, io=None, commodity_map=None, start_date=START_DATE,
                dependencies=None, log=print, download_options=None):
    """
    One refresh attempt. downloader(symbols, start, end) -> Mapping[symbol -> response];
    download_options (default None = legacy call, no extra arguments) is a dict such as
    {"auto_adjust": False, "price_field": "Close"} passed to the downloader as keyword
    arguments and recorded in the sidecar;
    a response is {"dates": [...], "prices": [...], "price_field": "..."}; a value that is
    an Exception instance (or a missing symbol) is a per-instrument failure; an exception
    raised by the downloader (including TimeoutError) fails every instrument.
    Returns a result dict containing exit_status.
    """
    clock = clock or (lambda: datetime.now(timezone.utc))
    io = io or FileIO()
    cmap = dict(commodity_map or COMMODITY_MAP)
    dataset_path = os.path.join(output_dir, dataset_file)
    sidecar_path = os.path.join(output_dir, sidecar_file)
    started = clock()
    as_of = started.astimezone(timezone.utc).date()
    end_date = as_of.isoformat()
    result = {"exit_status": EXIT_FAILED, "outcome": "failed", "dataset_replaced": False,
              "instruments": {}, "sidecar_written": False, "sidecar_error": None,
              "dataset_error": None, "dataset_sha256": None, "as_of": end_date}

    # 1. Load and validate the existing dataset BEFORE any request.
    status, prior, prior_raw, why = load_previous(dataset_path)
    if status == "invalid":
        result.update(exit_status=EXIT_REFUSED, outcome="refused", dataset_error=why)
        log("REFUSED: existing %s is unreadable or invalid (%s). Nothing requested or written." % (dataset_file, why))
        return result
    prior_hash = sha256_hex(prior_raw) if prior_raw is not None else None
    prior_side = load_previous_sidecar(sidecar_path)
    prior_side_valid = bool(prior_side and prior_hash and prior_side.get("dataset_sha256") == prior_hash)
    prior_instruments = (prior_side or {}).get("instruments") if prior_side_valid else {}
    prior_instruments = prior_instruments if isinstance(prior_instruments, dict) else {}

    # 2. Request (the real provider call lives only in the injected downloader).
    symbols = list(cmap.values())
    responses, batch_error = {}, None
    options = dict(download_options or {})
    try:
        responses = downloader(symbols, start_date, end_date, **options)
        if not isinstance(responses, Mapping):
            batch_error = "downloader returned %s, not a mapping" % type(responses).__name__
            responses = {}
    except Exception as exc:
        batch_error = "%s: %s" % (type(exc).__name__, exc)
        responses = {}

    # 3. Validate each instrument and decide: refreshed / retained / unavailable.
    candidate = {}
    for name, symbol in cmap.items():
        rec = {"symbol": symbol, "status": None, "reasons": [], "price_field": None,
               "attempt": None, "coverage": None, "revisions": None,
               "last_successful_refresh_utc": None, "last_successful_refresh_known": False}
        result["instruments"][name] = rec
        prev_entry = prior.get(name)
        prev_map, prev_why = (check_previous_series(prev_entry) if name in prior else (None, "no saved series"))

        resp = None
        if batch_error:
            rec["reasons"].append("download failed: " + batch_error)
        elif symbol not in responses or responses[symbol] is None:
            rec["reasons"].append("no response for symbol %s" % symbol)
        elif isinstance(responses[symbol], BaseException):
            exc = responses[symbol]
            rec["reasons"].append("provider error: %s: %s" % (type(exc).__name__, exc))
        else:
            resp = responses[symbol]

        accepted = None
        if resp is not None:
            v = validate_candidate(resp, as_of)
            rec["attempt"] = v["stats"] or None
            if not v["ok"]:
                rec["reasons"].extend("response rejected: " + r for r in v["reasons"])
            else:
                if prev_map is not None:
                    cmp = compare_with_previous(prev_map, v["labels"], v["prices"])
                    rec["revisions"] = cmp["revisions"]
                    if not cmp["ok"]:
                        rec["reasons"].extend("candidate rejected: " + r for r in cmp["reasons"])
                    else:
                        accepted = v
                else:
                    accepted = v
                    if name in prior:
                        rec["reasons"].append("saved series was unusable (%s); replaced by validated candidate" % prev_why)

        known = prior_instruments.get(name) if isinstance(prior_instruments.get(name), dict) else {}
        if accepted is not None:
            rec["status"] = "refreshed"
            rec["price_field"] = accepted["stats"].get("price_field")
            rec["last_successful_refresh_utc"] = _utc_iso(started)
            rec["last_successful_refresh_known"] = True
            rec["coverage"] = _coverage(accepted["labels"])
            candidate[name] = {"labels": accepted["labels"], "prices": accepted["prices"]}
        else:
            rec["last_successful_refresh_utc"] = known.get("last_successful_refresh_utc")
            rec["last_successful_refresh_known"] = bool(known.get("last_successful_refresh_known") and rec["last_successful_refresh_utc"])
            rec["price_field"] = known.get("price_field")
            if prev_map is not None:
                rec["status"] = "retained"
                rec["coverage"] = _coverage(prev_entry["labels"])
                candidate[name] = prev_entry
            elif name in prior:
                rec["status"] = "unavailable"
                rec["reasons"].append("previous series unusable (%s); carried over unchanged, not validated" % prev_why)
                rec["coverage"] = None
                candidate[name] = prev_entry
            else:
                rec["status"] = "unavailable"
                rec["reasons"].append("no usable previous series")

    for name, entry in prior.items():       # saved instruments this collector does not request
        if name not in cmap:
            candidate[name] = entry
            result["instruments"][name] = {"symbol": None, "status": "not_requested_retained",
                                           "reasons": ["not in COMMODITY_MAP; carried over unchanged"],
                                           "coverage": None, "last_successful_refresh_known": False,
                                           "last_successful_refresh_utc": None, "price_field": None,
                                           "attempt": None, "revisions": None}

    requested = [r for n, r in result["instruments"].items() if n in cmap]
    refreshed = [r for r in requested if r["status"] == "refreshed"]
    result["counts"] = {"requested": len(requested), "refreshed": len(refreshed),
                        "retained": sum(1 for r in requested if r["status"] == "retained"),
                        "unavailable": sum(1 for r in requested if r["status"] == "unavailable")}

    # 4. Write the dataset only if at least one instrument was refreshed.
    on_disk_hash = prior_hash
    if not refreshed:
        result.update(exit_status=EXIT_FAILED, outcome="failed")
        log("UNSUCCESSFUL REFRESH: no instrument was refreshed; %s left unchanged." % dataset_file)
    else:
        try:
            payload = serialize_document(candidate)
        except Exception as exc:
            payload, result["dataset_error"] = None, "serialization failed: %s: %s" % (type(exc).__name__, exc)
        if payload is not None:
            try:
                io.write_atomic(dataset_path, payload,
                                verify=lambda raw: _verify_dataset_bytes(raw, candidate))
                result["dataset_replaced"] = True
                on_disk_hash = sha256_hex(payload)
            except WriteError as exc:
                result["dataset_error"] = "write failed: %s" % exc
        if result["dataset_replaced"]:
            full = result["counts"]["refreshed"] == result["counts"]["requested"]
            result.update(exit_status=EXIT_OK if full else EXIT_PARTIAL,
                          outcome="success" if full else "partial")
        else:
            result.update(exit_status=EXIT_WRITE_FAILED, outcome="write_failed")
            log("WRITE FAILED (%s); previous %s preserved." % (result["dataset_error"], dataset_file))
    result["dataset_sha256"] = on_disk_hash

    # 5. Sidecar (a separate write; not one transaction with the dataset).
    completed = clock()
    sidecar = {
        "schema": SIDECAR_SCHEMA,
        "collector": "commodity_tracker.py",
        "collector_version": COLLECTOR_VERSION,
        "dataset_file": dataset_file,
        "dataset_sha256": on_disk_hash,
        "dataset_replaced_by_this_attempt": result["dataset_replaced"],
        "atomicity_note": "Dataset and sidecar are written as two separate atomic file replacements, not one "
                          "transaction. Compare dataset_sha256 with the dataset (py commodity_tracker.py --verify).",
        "provider": PROVIDER,
        "request": {"start": start_date, "end": end_date, "end_convention": "passed to the provider as given",
                    "interval": "not passed (provider default)",
                    "auto_adjust": ("explicit: %r" % options["auto_adjust"]) if options.get("auto_adjust") is not None
                                   else "not passed (provider/library default)",
                    "price_field_rule": ("explicit: %r" % options["price_field"]) if options.get("price_field")
                                        else "'Adj Close' if present for the symbol, else 'Close'",
                    "download_options": options,
                    "timeout_seconds": DOWNLOAD_TIMEOUT_S, "as_of_utc_date": end_date},
        "dependencies": dependencies if dependencies is not None else dependency_versions(),
        "last_attempt": {"started_utc": _utc_iso(started), "completed_utc": _utc_iso(completed),
                         "outcome": result["outcome"], "exit_status": result["exit_status"],
                         "batch_error": batch_error, "dataset_error": result["dataset_error"],
                         "counts": result["counts"]},
        "historical_provenance": "unknown for any record not listed as refreshed with a "
                                 "last_successful_refresh_utc by a sidecar-writing run; no provider, symbol, price "
                                 "field, adjustment or time is attributed to older records",
        "instruments": result["instruments"],
    }
    try:
        sidecar_bytes = serialize_document(sidecar)
        io.write_atomic(sidecar_path, sidecar_bytes, verify=lambda raw: strict_loads(raw))
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


def _verify_dataset_bytes(raw, candidate):
    parsed = strict_loads(raw)
    if parsed != candidate:
        raise WriteError("re-read dataset differs from the candidate")


def _print_summary(result, log):
    for name, rec in result["instruments"].items():
        cov = rec.get("coverage") or {}
        line = "  %-12s %-22s" % (name, rec["status"])
        if cov:
            line += " %s records %s..%s" % (cov["records"], cov["first"], cov["last"])
        log(line)
        for r in rec["reasons"]:
            log("      - " + r)
        rv = rec.get("revisions")
        if rec["status"] == "refreshed" and rv and rv["revised_dates"]:
            log("      - revisions disclosed: %d shared date(s) changed, max abs %s (cause not inferred)" % (
                rv["revised_dates"], rv["max_abs_change"]))
    log("Outcome: %s (exit %d); dataset replaced: %s; sidecar written: %s" % (
        result["outcome"], result["exit_status"], result["dataset_replaced"], result["sidecar_written"]))


# ------------------------------------------------------- real provider adapter --

def frame_to_responses(frame, symbols, price_field=None):
    """
    Convert a yfinance DataFrame into per-symbol responses (duck-typed; pandas is not
    imported here). NaN rows are passed through so validation can count them.
    price_field=None keeps the legacy rule ('Adj Close' if present, else 'Close'); an
    explicit name uses only that column (a missing column is a per-symbol failure).
    """
    fields = (price_field,) if price_field else ("Adj Close", "Close")
    out = {}
    if frame is None or getattr(frame, "empty", True):
        return out
    cols = list(frame.columns)
    multi = getattr(frame.columns, "nlevels", 1) > 1
    for sym in symbols:
        try:
            field = None
            for cand in fields:
                if (multi and (cand, sym) in cols) or (not multi and len(symbols) == 1 and cand in cols):
                    field = cand
                    break
            if field is None:
                out[sym] = KeyError("no %s column for %s" % (" or ".join(repr(f) for f in fields), sym))
                continue
            series = frame[(field, sym)] if multi else frame[field]
            out[sym] = {"dates": [ts.strftime("%Y-%m-%d") for ts in frame.index],
                        "prices": series.tolist(), "price_field": field}
        except Exception as exc:
            out[sym] = exc
    return out


def yfinance_downloader(symbols, start, end, auto_adjust=None, price_field=None):
    """
    The only function that touches the provider. Imported lazily; offline tests stub the
    module. auto_adjust=None leaves the library default (legacy behaviour); True/False is
    passed explicitly. price_field=None keeps the legacy field rule; an explicit name selects
    that column only.
    """
    import inspect
    import yfinance as yf
    kwargs = {}
    if auto_adjust is not None:
        kwargs["auto_adjust"] = bool(auto_adjust)
    try:
        if "timeout" in inspect.signature(yf.download).parameters:
            kwargs["timeout"] = DOWNLOAD_TIMEOUT_S
    except (TypeError, ValueError):
        pass
    frame = yf.download(list(symbols), start=start, end=end, **kwargs)
    return frame_to_responses(frame, list(symbols), price_field=price_field)


# ----------------------------------------------------------------------- CLI --

def build_parser():
    p = argparse.ArgumentParser(description="Commodity collector with failure safety.")
    p.add_argument("--output-dir", default=".", help="directory holding %s (default: .)" % DATASET_FILE)
    p.add_argument("--auto-adjust", choices=("default", "true", "false"), default="default",
                   help="provider auto_adjust: 'default' = not passed (library default, legacy behaviour)")
    p.add_argument("--price-field", choices=("auto", "Close", "Adj Close"), default="auto",
                   help="'auto' = legacy rule ('Adj Close' if present else 'Close')")
    p.add_argument("--verify", action="store_true",
                   help="offline: check the dataset against its sidecar hash; no download, no write")
    return p


def main(argv=None, downloader=None, clock=None, io=None, log=print):
    args = build_parser().parse_args(argv)
    if args.verify:
        res = verify_consistency(os.path.join(args.output_dir, DATASET_FILE),
                                 os.path.join(args.output_dir, SIDECAR_FILE))
        log("%s: %s" % (res["status"], res["detail"]))
        return EXIT_OK if res["status"] == "consistent" else EXIT_VERIFY_FAILED
    log("Fetching %d commodities from %s (provider: %s)..." % (len(COMMODITY_MAP), START_DATE, PROVIDER))
    options = {}
    if args.auto_adjust != "default":
        options["auto_adjust"] = (args.auto_adjust == "true")
    if args.price_field != "auto":
        options["price_field"] = args.price_field
    result = run_refresh(downloader or yfinance_downloader, output_dir=args.output_dir,
                         clock=clock, io=io, log=log, download_options=options or None)
    return result["exit_status"]


def track_commodities():
    """Backward-compatible entry point."""
    return main([])


if __name__ == "__main__":
    sys.exit(main())
