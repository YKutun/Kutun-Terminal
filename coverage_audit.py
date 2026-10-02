"""
coverage_audit.py - Kutun Terminal Stage 2A
===========================================
READ-ONLY data-coverage audit of the saved price histories.

* Reads commodities_data.json, sector_historical.json and equity_data.json.
* Never writes, never imports a collector, never imports yfinance, makes no
  network request. Output goes to stdout only.
* The audit date is an explicit required input so a run is reproducible:

      py coverage_audit.py --as-of 2026-09-30
      py coverage_audit.py --as-of 2026-09-30 --json
      py coverage_audit.py --as-of 2026-09-30 --annual Gold,Platinum,Palladium,Lumber

Vocabulary (deliberately conservative)
--------------------------------------
* A "calendar gap" is two consecutive usable observations more than
  GAP_WARN_DAYS calendar days apart. It is NOT a confirmed missing trading
  session; no exchange calendar is consulted or inferred.
* "usable observation" = a record with a valid ISO calendar date and a finite
  numeric price (zero and negative are finite and counted as usable; they are
  reported separately and are not assumed to be errors).
* "leading flat run" = number of leading usable observations that all equal the
  first price. It is EVIDENCE of a possible backward fill, not proof.
* Window semantics replicate the documented Latest Snapshot policy (today-UTC
  anchored, inclusive cutoff, calendar-month arithmetic with month-end
  clamping, MAX floor 2005-01-01) using the explicit --as-of date as "today".
  This is an independent re-implementation for diagnosis only.
"""

import argparse
import calendar
import json
import math
import os
import re
import sys
from datetime import date, timedelta

GAP_WARN_DAYS = 7
STALE_DAYS = 30                 # same simple age threshold as the dashboard
MAX_FLOOR = date(2005, 1, 1)
WINDOWS = ["1W", "1M", "3M", "6M", "YTD", "1Y", "5Y", "MAX"]
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")

DATASET_FILES = {
    "commodities": "commodities_data.json",
    "sector": "sector_historical.json",
    "equity": "equity_data.json",
}


# ---------------------------------------------------------------- parsing --

class DupDict(dict):
    """dict that remembers JSON object keys that appeared more than once."""
    dup_keys = ()


def _pairs_hook(pairs):
    d = DupDict()
    dups = []
    for k, v in pairs:
        if k in d:
            dups.append(k)
        d[k] = v
    d.dup_keys = tuple(dups)
    return d


def load_json_readonly(path):
    """Parse JSON (bare NaN/Infinity tokens are accepted by Python and kept as floats)."""
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh, object_pairs_hook=_pairs_hook)


def parse_iso_date(value):
    """Strict YYYY-MM-DD real calendar date, else None."""
    if not isinstance(value, str) or not _ISO.match(value):
        return None
    try:
        return date(int(value[0:4]), int(value[5:7]), int(value[8:10]))
    except ValueError:
        return None


def classify_price(value):
    """Return (kind, finite_float_or_None). kind in finite|null|non_numeric|non_finite."""
    if value is None:
        return "null", None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "non_numeric", None
    if not math.isfinite(value):
        return "non_finite", None
    return "finite", float(value)


# ---------------------------------------------------------------- windows --

def add_months_clamped(d, months):
    """d + months calendar months, day clamped to the end of the target month."""
    total = d.year * 12 + (d.month - 1) + months
    y, m = divmod(total, 12)
    m += 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def window_cutoff(timeframe, as_of):
    if timeframe == "1W":
        return as_of - timedelta(days=7)
    if timeframe == "1M":
        return add_months_clamped(as_of, -1)
    if timeframe == "3M":
        return add_months_clamped(as_of, -3)
    if timeframe == "6M":
        return add_months_clamped(as_of, -6)
    if timeframe == "YTD":
        return date(as_of.year, 1, 1)
    if timeframe == "1Y":
        return add_months_clamped(as_of, -12)
    if timeframe == "5Y":
        return add_months_clamped(as_of, -60)
    if timeframe == "MAX":
        return MAX_FLOOR
    raise ValueError("unknown timeframe " + repr(timeframe))


# ----------------------------------------------------------------- audit --

def _gap_stats(days):
    """days: sorted list of unique datetime.date. Returns count > threshold and largest."""
    count = 0
    largest = {"days": 0, "from": None, "to": None}
    for a, b in zip(days, days[1:]):
        g = (b - a).days
        if g > GAP_WARN_DAYS:
            count += 1
        if g > largest["days"]:
            largest = {"days": g, "from": a.isoformat(), "to": b.isoformat()}
    if largest["days"] == 0:
        largest = {"days": 0, "from": None, "to": None}
    return count, largest


def _sort_order(valid_dates_in_file_order):
    d = valid_dates_in_file_order
    if len(d) < 2:
        return "single_or_empty"
    if all(a < b for a, b in zip(d, d[1:])):
        return "ascending"
    if all(a > b for a, b in zip(d, d[1:])):
        return "descending"
    if all(a <= b for a, b in zip(d, d[1:])):
        return "ascending_with_duplicates"
    return "unsorted"


def audit_series(dataset, identifier, records, as_of, declared_length_mismatch=None,
                 duplicate_keys=0, structure_problem=None):
    """
    records: list of (raw_date, raw_price) in source order.
    declared_length_mismatch: None or (n_dates, n_values) when parallel arrays differ.
    duplicate_keys: duplicate JSON object keys seen (date-keyed dict layouts).
    """
    n = len(records)
    kinds = {"finite": 0, "null": 0, "non_numeric": 0, "non_finite": 0}
    invalid_dates = 0
    zero = negative = future = 0
    valid_in_order = []
    seen = {}
    usable = {}                       # date -> price (first occurrence wins; duplicates counted)
    duplicates = 0
    for raw_date, raw_price in records:
        d = parse_iso_date(raw_date)
        kind, price = classify_price(raw_price)
        kinds[kind] += 1
        if d is None:
            invalid_dates += 1
            continue
        valid_in_order.append(d)
        if d in seen:
            duplicates += 1
        seen[d] = True
        if d > as_of:
            future += 1
        if kind == "finite":
            if price == 0:
                zero += 1
            elif price < 0:
                negative += 1
            if d not in usable:
                usable[d] = price
    usable_days = sorted(usable)
    gap_count, largest = _gap_stats(usable_days)
    annual = {}
    for d in usable_days:
        annual[str(d.year)] = annual.get(str(d.year), 0) + 1

    first_rec = min(valid_in_order).isoformat() if valid_in_order else None
    last_rec = max(valid_in_order).isoformat() if valid_in_order else None
    last_finite = usable_days[-1] if usable_days else None
    age = (as_of - last_finite).days if last_finite else None

    # leading flat run over usable observations (possible backward fill evidence)
    flat = 0
    flat_last = None
    if usable_days:
        p0 = usable[usable_days[0]]
        for d in usable_days:
            if usable[d] == p0:
                flat += 1
                flat_last = d
            else:
                break

    windows = {}
    for tf in WINDOWS:
        cut = window_cutoff(tf, as_of)
        in_win = [d for d in usable_days if d >= cut]
        wg, wl = _gap_stats(in_win)
        windows[tf] = {
            "cutoff": cut.isoformat(),
            "finite_observations": len(in_win),
            "state": ("no_observations" if not in_win
                      else "single_observation" if len(in_win) == 1
                      else "multiple_observations"),
            "first_valid": in_win[0].isoformat() if in_win else None,
            "last_valid": in_win[-1].isoformat() if in_win else None,
            "calendar_gaps_over_7d": wg,
            "largest_gap": wl,
        }

    flags = []
    if structure_problem:
        flags.append("STRUCTURE_PROBLEM")
    if not usable_days:
        flags.append("NO_USABLE_OBSERVATIONS")
    elif len(usable_days) == 1:
        flags.append("SINGLE_OBSERVATION_SERIES")
    if age is not None and age > STALE_DAYS:
        flags.append("STALE_ENDING_COVERAGE")
    if gap_count:
        flags.append("INTERNAL_CALENDAR_GAPS")
    if invalid_dates:
        flags.append("INVALID_DATES")
    if duplicates or duplicate_keys:
        flags.append("DUPLICATE_DATES")
    if declared_length_mismatch:
        flags.append("UNEQUAL_LENGTHS")
    if kinds["null"] or kinds["non_numeric"] or kinds["non_finite"]:
        flags.append("INVALID_PRICES")
    if zero:
        flags.append("ZERO_PRICES")
    if negative:
        flags.append("NEGATIVE_PRICES")
    if future:
        flags.append("FUTURE_DATED")
    if flat >= 20:
        flags.append("LEADING_FLAT_RUN_POSSIBLE_BACKFILL")

    return {
        "dataset": dataset,
        "id": identifier,
        "records": n,
        "finite_prices": kinds["finite"],
        "usable_observations": len(usable_days),
        "first_record_date": first_rec,
        "latest_record_date": last_rec,
        "latest_finite_date": last_finite.isoformat() if last_finite else None,
        "latest_price_age_days": age,
        "invalid_dates": invalid_dates,
        "duplicate_dates": duplicates,
        "duplicate_json_keys": duplicate_keys,
        "source_sort_order": _sort_order(valid_in_order),
        "unequal_lengths": (list(declared_length_mismatch) if declared_length_mismatch else None),
        "null_prices": kinds["null"],
        "non_numeric_prices": kinds["non_numeric"],
        "non_finite_prices": kinds["non_finite"],
        "zero_prices": zero,
        "negative_prices": negative,
        "future_dated_records": future,
        "calendar_gaps_over_7d": gap_count,
        "largest_gap": largest,
        "leading_flat_run": {"length": flat,
                             "last_date": flat_last.isoformat() if flat_last else None},
        "annual_counts": annual,
        "windows": windows,
        "flags": flags,
        "structure_problem": structure_problem,
    }


# ------------------------------------------------------------ dataset glue --

def audit_commodities(data, as_of):
    out = []
    if not isinstance(data, dict):
        return [audit_series("commodities", "(file)", [], as_of,
                             structure_problem="top level is not an object")]
    for name, rec in data.items():
        if not isinstance(rec, dict) or not isinstance(rec.get("labels"), list) \
                or not isinstance(rec.get("prices"), list):
            out.append(audit_series("commodities", name, [], as_of,
                                    structure_problem="labels/prices missing or not lists"))
            continue
        labels, prices = rec["labels"], rec["prices"]
        mismatch = (len(labels), len(prices)) if len(labels) != len(prices) else None
        pairs = list(zip(labels, prices))      # extras beyond the shorter list are unpaired
        out.append(audit_series("commodities", name, pairs, as_of,
                                declared_length_mismatch=mismatch))
    return out


def audit_sectors(data, as_of):
    out = []
    if not isinstance(data, dict):
        return [audit_series("sector", "(file)", [], as_of,
                             structure_problem="top level is not an object")]
    for sym, rows in data.items():
        if not isinstance(rows, list):
            out.append(audit_series("sector", sym, [], as_of,
                                    structure_problem="series is not a list of observations"))
            continue
        pairs = []
        bad_rows = 0
        for r in rows:
            if isinstance(r, dict):
                pairs.append((r.get("x"), r.get("y")))
            else:
                pairs.append((None, None))
                bad_rows += 1
        out.append(audit_series("sector", sym, pairs, as_of,
                                structure_problem=("%d rows are not objects" % bad_rows) if bad_rows else None))
    return out


def audit_equities(data, as_of):
    out = []
    if not isinstance(data, dict):
        return [audit_series("equity", "(file)", [], as_of,
                             structure_problem="top level is not an object")]
    for sym, entry in data.items():
        hp = entry.get("historical_prices") if isinstance(entry, dict) else None
        if not isinstance(hp, dict):
            out.append(audit_series("equity", sym, [], as_of,
                                    structure_problem="historical_prices missing or not an object"))
            continue
        dup = len(getattr(hp, "dup_keys", ()))
        out.append(audit_series("equity", sym, list(hp.items()), as_of, duplicate_keys=dup))
    return out


def run_audit(root, as_of):
    results = []
    missing = []
    for ds, fname in DATASET_FILES.items():
        path = os.path.join(root, fname)
        if not os.path.isfile(path):
            missing.append(fname)
            continue
        data = load_json_readonly(path)
        fn = {"commodities": audit_commodities, "sector": audit_sectors,
              "equity": audit_equities}[ds]
        results.extend(fn(data, as_of))
    return {"as_of": as_of.isoformat(), "root": os.path.abspath(root),
            "missing_files": missing, "series": results}


# ----------------------------------------------------------------- output --

def render_text(report, annual_for=()):
    lines = []
    lines.append("KUTUN COVERAGE AUDIT (read-only)  as-of %s  root %s" % (report["as_of"], report["root"]))
    lines.append("Calendar gaps are not confirmed missing trading sessions. Leading flat runs are evidence of "
                 "possible backward fill, not proof.")
    if report["missing_files"]:
        lines.append("MISSING FILES: " + ", ".join(report["missing_files"]))
    for ds in ("commodities", "sector", "equity"):
        rows = [s for s in report["series"] if s["dataset"] == ds]
        if not rows:
            continue
        lines.append("")
        lines.append("== %s (%d series) ==" % (ds, len(rows)))
        lines.append("%-12s %6s %6s %-10s %-10s %-10s %5s %5s %5s %5s  %s" % (
            "id", "recs", "usable", "first", "last", "lastFinite", "age", "gaps", "maxgap", "flat", "flags"))
        for s in rows:
            lines.append("%-12s %6d %6d %-10s %-10s %-10s %5s %5d %5d %5d  %s" % (
                s["id"], s["records"], s["usable_observations"],
                s["first_record_date"], s["latest_record_date"], s["latest_finite_date"],
                s["latest_price_age_days"], s["calendar_gaps_over_7d"], s["largest_gap"]["days"],
                s["leading_flat_run"]["length"], ",".join(s["flags"]) or "-"))
    lines.append("")
    lines.append("== window states (finite observations in window; state) ==")
    lines.append("%-12s " % "id" + " ".join("%-16s" % w for w in WINDOWS))
    for s in report["series"]:
        if s["dataset"] == "equity":
            continue   # equities are listed in JSON; ~1y history only
        cells = []
        for w in WINDOWS:
            ws = s["windows"][w]
            tag = {"no_observations": "none", "single_observation": "SINGLE",
                   "multiple_observations": "multi"}[ws["state"]]
            cells.append("%-16s" % ("%d %s" % (ws["finite_observations"], tag)))
        lines.append("%-12s " % s["id"] + " ".join(cells))
    detail = [s for s in report["series"] if s["largest_gap"]["days"] > GAP_WARN_DAYS]
    if detail:
        lines.append("")
        lines.append("== largest calendar gaps (> %d days) ==" % GAP_WARN_DAYS)
        for s in detail:
            g = s["largest_gap"]
            lines.append("%-12s %s %-10s %3d days  %s -> %s  (%d gaps)" % (
                s["dataset"], "", s["id"], g["days"], g["from"], g["to"], s["calendar_gaps_over_7d"]))
    for name in annual_for:
        hit = [s for s in report["series"] if s["id"] == name]
        for s in hit:
            lines.append("")
            lines.append("annual usable observations: %s/%s" % (s["dataset"], s["id"]))
            lines.append("  " + ", ".join("%s:%d" % (y, c) for y, c in sorted(s["annual_counts"].items())))
    return "\n".join(lines)


def build_parser():
    p = argparse.ArgumentParser(description="Read-only coverage audit of saved Kutun price histories.")
    p.add_argument("--as-of", required=True, metavar="YYYY-MM-DD",
                   help="explicit audit date (required; used for ages, future dates and windows)")
    p.add_argument("--root", default=".", help="project root containing the dataset files (default: .)")
    p.add_argument("--json", action="store_true", help="print the full report as JSON")
    p.add_argument("--annual", default="", help="comma-separated series ids whose annual counts to print")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    as_of = parse_iso_date(args.as_of)
    if as_of is None:
        print("ERROR: --as-of must be a real calendar date in YYYY-MM-DD form", file=sys.stderr)
        return 2
    report = run_audit(args.root, as_of)
    if args.json:
        print(json.dumps(report, indent=2, allow_nan=False))
    else:
        print(render_text(report, [x for x in args.annual.split(",") if x]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
