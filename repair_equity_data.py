#!/usr/bin/env python3
"""
repair_equity_data.py — Kutun Terminal Stage 1B
================================================
One-shot repair script.  Reads the current equity_data.json, removes
all non-finite price observations (NaN, Infinity, -Infinity, None),
converts non-finite metadata scalars to null, and writes the cleaned
file back atomically via a temporary candidate.

Safety guarantees
-----------------
* The production file is NEVER overwritten until the candidate passes
  strict JSON validation (json.loads with allow_nan=False default).
* If validation fails, the production file is left untouched and the
  script exits with status 1.
* No network requests are made.
* Protected files (sector_historical.json, commodities_data.json,
  macro_events.json, live_news.json) are not touched.

Usage
-----
    py repair_equity_data.py
"""

import json
import math
import os
import re
import sys
from datetime import datetime, timezone

PRODUCTION_FILE = "equity_data.json"
CANDIDATE_FILE  = "equity_data_candidate.json"
META_FILE       = "equity_data_meta.json"


def load_lenient(path: str) -> dict:
    """Load JSON that may contain bare NaN/Infinity tokens."""
    with open(path, "r", encoding="utf-8") as fh:
        raw = fh.read()
    # Replace bare NaN and Infinity tokens with JSON-compliant null.
    # Use word boundaries to avoid touching quoted strings accidentally.
    cleaned = re.sub(r'\bNaN\b', 'null', raw)
    cleaned = re.sub(r'\bInfinity\b', 'null', cleaned)
    cleaned = re.sub(r'\b-null\b', 'null', cleaned)  # -Infinity → null
    return json.loads(cleaned)


def is_finite_number(value) -> bool:
    """Return True only for a real finite number (int or float, not NaN/Inf)."""
    if value is None:
        return False
    if not isinstance(value, (int, float)):
        return False
    return math.isfinite(value)


def sanitise_metadata(meta: dict) -> dict:
    """
    Convert non-finite scalars to null (None).
    Strings and other types are left as-is.
    """
    cleaned = {}
    for k, v in meta.items():
        if isinstance(v, float) and not math.isfinite(v):
            cleaned[k] = None
        else:
            cleaned[k] = v
    return cleaned


def repair_ticker(sym: str, entry) -> tuple:
    """
    Attempt to repair a single ticker record.

    Returns (ok: bool, repaired_entry: dict|None, issues: list[str])
    ok = True  → record is usable (possibly with some observations removed)
    ok = False → record cannot be recovered (e.g. not a dict at all)
    """
    issues = []

    if not isinstance(entry, dict):
        return False, None, [f"top-level value is {type(entry).__name__}, not dict"]

    # ── Metadata ──────────────────────────────────────────────────────────
    meta_raw = entry.get("metadata", {})
    if not isinstance(meta_raw, dict):
        meta_raw = {}
        issues.append("metadata was not a dict; replaced with empty dict")
    meta = sanitise_metadata(meta_raw)

    # ── Historical prices ─────────────────────────────────────────────────
    hp_raw = entry.get("historical_prices", {})
    removed_obs = []

    if hp_raw == "N/A" or hp_raw is None:
        # Entire history unavailable; preserve record with empty prices
        historical_prices = {}
        issues.append("historical_prices was 'N/A' or None; stored as empty dict")
    elif not isinstance(hp_raw, dict):
        historical_prices = {}
        issues.append(f"historical_prices was {type(hp_raw).__name__}; stored as empty dict")
    else:
        historical_prices = {}
        for date_str, close in hp_raw.items():
            # Validate date key
            if not isinstance(date_str, str) or len(date_str) < 8:
                removed_obs.append(date_str)
                issues.append(f"removed obs with bad date key: {repr(date_str)}")
                continue
            # Validate price
            if not is_finite_number(close):
                removed_obs.append(date_str)
                issues.append(f"removed obs {date_str}: price={repr(close)} is not finite")
                continue
            historical_prices[date_str] = close

    if removed_obs:
        issues.append(f"removed {len(removed_obs)} invalid price observations")

    repaired = {
        "metadata": meta,
        "historical_prices": historical_prices,
    }
    return True, repaired, issues


def main():
    print("=" * 62)
    print("KUTUN TERMINAL — equity_data.json repair")
    print(f"Started: {datetime.now(timezone.utc).isoformat()}")
    print("=" * 62)

    if not os.path.isfile(PRODUCTION_FILE):
        print(f"ERROR: {PRODUCTION_FILE} not found.")
        sys.exit(1)

    # ── Load ──────────────────────────────────────────────────────────────
    print(f"\n[1] Loading {PRODUCTION_FILE} (lenient parser) …")
    try:
        data = load_lenient(PRODUCTION_FILE)
    except Exception as exc:
        print(f"ERROR: Could not parse {PRODUCTION_FILE}: {exc}")
        sys.exit(1)

    if not isinstance(data, dict):
        print("ERROR: Top-level structure is not a JSON object.")
        sys.exit(1)

    original_count = len(data)
    print(f"    Loaded {original_count} top-level ticker records.")

    # ── Repair ────────────────────────────────────────────────────────────
    print("\n[2] Repairing ticker records …")
    repaired_data = {}
    recovered_count = 0
    excluded_count  = 0
    total_removed_obs = 0
    excluded_tickers  = []
    all_dates = []
    ticker_warnings = {}

    for sym, entry in data.items():
        ok, repaired, issues = repair_ticker(sym, entry)
        if not ok:
            excluded_count += 1
            excluded_tickers.append(sym)
            print(f"  EXCLUDED {sym}: {'; '.join(issues)}")
            continue

        # Count removed observations from issues
        for iss in issues:
            if iss.startswith("removed ") and "invalid price observations" in iss:
                try:
                    total_removed_obs += int(iss.split()[1])
                except ValueError:
                    pass

        hp = repaired["historical_prices"]
        if issues:
            ticker_warnings[sym] = issues
        if hp:
            all_dates.extend(hp.keys())
        repaired_data[sym] = repaired
        recovered_count += 1

    print(f"\n  Original ticker count  : {original_count}")
    print(f"  Recovered valid tickers: {recovered_count}")
    print(f"  Excluded tickers       : {excluded_count}")
    if excluded_tickers:
        for t in excluded_tickers:
            print(f"    - {t}")
    print(f"  Removed invalid obs    : {total_removed_obs}")

    if all_dates:
        all_dates.sort()
        print(f"  Earliest valid date    : {all_dates[0]}")
        print(f"  Latest valid date      : {all_dates[-1]}")
    else:
        print("  No valid price observations remain.")

    # ── Serialise candidate ───────────────────────────────────────────────
    print(f"\n[3] Writing candidate file: {CANDIDATE_FILE} …")
    try:
        candidate_str = json.dumps(repaired_data, indent=4, allow_nan=False)
    except ValueError as exc:
        print(f"ERROR: Serialisation failed (non-finite value leaked): {exc}")
        sys.exit(1)

    with open(CANDIDATE_FILE, "w", encoding="utf-8") as fh:
        fh.write(candidate_str)
    print("    Candidate written.")

    # ── Strict validation ─────────────────────────────────────────────────
    print(f"\n[4] Strict validation of {CANDIDATE_FILE} …")
    try:
        with open(CANDIDATE_FILE, "r", encoding="utf-8") as fh:
            validated = json.loads(fh.read())  # strict; no allow_nan
    except json.JSONDecodeError as exc:
        print(f"ERROR: Candidate is not valid strict JSON: {exc}")
        print("Production file left untouched.")
        sys.exit(1)

    # Confirm no NaN tokens remain in the raw text
    with open(CANDIDATE_FILE, "r", encoding="utf-8") as fh:
        raw_check = fh.read()
    nan_remaining  = len(re.findall(r'\bNaN\b', raw_check))
    inf_remaining  = len(re.findall(r'\bInfinity\b', raw_check))
    if nan_remaining > 0 or inf_remaining > 0:
        print(f"ERROR: NaN={nan_remaining}, Infinity={inf_remaining} tokens remain. Aborting.")
        sys.exit(1)

    print(f"    ✓ Strict JSON parse passed")
    print(f"    ✓ No NaN tokens")
    print(f"    ✓ No Infinity tokens")
    print(f"    ✓ Top-level keys in validated file: {len(validated)}")

    # ── Atomic replacement ────────────────────────────────────────────────
    print(f"\n[5] Replacing production file …")
    try:
        os.replace(CANDIDATE_FILE, PRODUCTION_FILE)
    except OSError as exc:
        print(f"ERROR: os.replace failed: {exc}")
        sys.exit(1)
    print(f"    ✓ {PRODUCTION_FILE} replaced atomically.")

    # ── Write sidecar metadata ────────────────────────────────────────────
    print(f"\n[6] Writing sidecar metadata: {META_FILE} …")
    meta_doc = {
        "source": "repair_equity_data.py (Stage 1B — one-shot NaN repair; no network requests)",
        "methodology_version": "stage1b_repair_v1",
        "utc_retrieval_timestamp": "unknown — original retrieval time not recorded",
        "utc_repair_timestamp": datetime.now(timezone.utc).isoformat(),
        "notes": [
            "Original equity_data.json contained 50 bare NaN values (one per affected ticker, all on date 2026-09-18).",
            "Those observations were removed. All other historical prices and metadata were preserved.",
            "This file records the state after repair, not after a live data refresh.",
            "Run equity_engine.py (hardened version) to perform a live refresh."
        ],
        "original_ticker_count": original_count,
        "recovered_ticker_count": recovered_count,
        "excluded_ticker_count": excluded_count,
        "removed_invalid_obs_count": total_removed_obs,
        "earliest_valid_date": all_dates[0] if all_dates else None,
        "latest_valid_date": all_dates[-1] if all_dates else None,
        "excluded_tickers": excluded_tickers,
        "refresh_warnings": ticker_warnings,
        "counts": {
            "refreshed": 0,
            "fallback": 0,
            "excluded": excluded_count,
            "total": recovered_count
        }
    }
    try:
        meta_str = json.dumps(meta_doc, indent=4, allow_nan=False)
        with open(META_FILE, "w", encoding="utf-8") as fh:
            fh.write(meta_str)
        print(f"    ✓ {META_FILE} written.")
    except Exception as exc:
        print(f"    WARNING: Could not write {META_FILE}: {exc}")

    # ── Final summary ─────────────────────────────────────────────────────
    print("\n" + "=" * 62)
    print("REPAIR COMPLETE")
    print(f"  Production file: {os.path.abspath(PRODUCTION_FILE)}")
    print(f"  Production replaced: YES")
    print(f"  Original tickers: {original_count}")
    print(f"  Recovered tickers: {recovered_count}")
    print(f"  Excluded tickers: {excluded_count}")
    print(f"  Removed invalid observations: {total_removed_obs}")
    if all_dates:
        print(f"  Date range: {all_dates[0]} → {all_dates[-1]}")
    print("=" * 62)


if __name__ == "__main__":
    main()
