#!/usr/bin/env python3
"""
equity_engine.py — Kutun Terminal Stage 1B
==========================================
Safe equity data collector with atomic replacement and last-good fallback.

Design principles
-----------------
1. The current valid equity_data.json is loaded as a "last-good" dataset
   BEFORE any network requests begin.
2. Each ticker is processed independently.  A failure in one ticker never
   causes another to be discarded.
3. If a ticker download fails or produces invalid data, the last-good record
   for that ticker is preserved.
4. Non-finite metadata values (NaN, Infinity) are converted to null.
5. Non-finite or missing price observations are removed, never zeroed.
6. The result is written to a TEMPORARY candidate file first.
7. The candidate is validated with strict JSON parsing before anything is
   overwritten.
8. os.replace() is used for atomic replacement.
9. If candidate validation fails, the production file is left untouched
   and the script exits with status 1.
10. No network requests are made when this module is imported.

Minimum-ticker threshold
------------------------
MIN_VALID_TICKERS (default: 30) is the minimum number of valid ticker
records required before the candidate is allowed to replace production data.
Rationale: if a broad API failure returns empty or invalid data for most
tickers, the engine should fall back to the existing snapshot rather than
overwrite a good dataset with a degraded one.  30 is deliberately below the
full count of 61 so that a partial refresh (some tickers temporarily failing)
still succeeds.  Adjust MIN_VALID_TICKERS to suit your risk tolerance.

Sidecar metadata
----------------
Each refresh writes equity_data_meta.json alongside equity_data.json.
It records source, retrieval timestamp, per-ticker latest dates, counts,
and any warnings.  It is NOT a fake ticker; it is a companion document.

Usage
-----
    C:\\...\\py.exe equity_engine.py      # full refresh
    C:\\...\\py.exe equity_engine.py --dry-run   # validate current file only
"""

import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone

# ── Configuration ────────────────────────────────────────────────────────────
PRODUCTION_FILE  = "equity_data.json"
CANDIDATE_FILE   = "equity_data_candidate.json"
META_FILE        = "equity_data_meta.json"
SCRIPT_VERSION   = "stage1b_v1"
REQUEST_DELAY_S  = 0.5   # seconds between ticker fetches (rate-limit courtesy)

# Minimum number of valid ticker records required to allow production replacement.
# If fewer tickers validate successfully, the candidate is rejected and the
# last-good production file is preserved.
MIN_VALID_TICKERS = 30

TARGET_TICKERS = [
    'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'BRK-B', 'LLY', 'AVGO', 'V',
    'JPM', 'TSLA', 'WMT', 'UNH', 'MA', 'PG', 'JNJ', 'HD', 'MRK', 'ORCL',
    'CVX', 'COST', 'ABBV', 'BAC', 'PEP', 'KO', 'NFLX', 'CRM', 'AMD', 'LIN',
    'TMO', 'MCD', 'DIS', 'CSCO', 'INTC', 'ABT', 'WFC', 'QCOM', 'IBM', 'CAT',
    'VZ', 'AMAT', 'UBER', 'PFE', 'GS', 'TXN', 'NOW', 'GE', 'ISRG', 'MS',
    'RY.TO', 'SHOP.TO', 'TD.TO', 'CNR.TO', 'CP.TO', 'ENB.TO', 'BAM.TO',
    'ATD.TO', 'BMO.TO', 'CSU.TO', 'DOL.TO',
]


# ── Helper functions ─────────────────────────────────────────────────────────

def load_lenient(path: str) -> dict:
    """
    Load a JSON file that may contain bare NaN/Infinity tokens (Python default).
    Only used for loading the last-good dataset.
    """
    with open(path, "r", encoding="utf-8") as fh:
        raw = fh.read()
    cleaned = re.sub(r'\bNaN\b', 'null', raw)
    cleaned = re.sub(r'\bInfinity\b', 'null', cleaned)
    cleaned = re.sub(r'\b-null\b', 'null', cleaned)
    return json.loads(cleaned)


def is_finite_number(value) -> bool:
    if value is None:
        return False
    if not isinstance(value, (int, float)):
        return False
    return math.isfinite(value)


def sanitise_scalar(value):
    """Convert non-finite floats to None; leave other types unchanged."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def sanitise_metadata(meta: dict) -> dict:
    return {k: sanitise_scalar(v) for k, v in meta.items()}


def clean_historical_prices(hp_raw) -> tuple[dict, list]:
    """
    Return (cleaned_prices_dict, list_of_removed_dates).
    Non-finite or None prices are removed, not zeroed.
    """
    if hp_raw is None or hp_raw == "N/A":
        return {}, ["historical_prices was N/A or None"]
    if not isinstance(hp_raw, dict):
        return {}, [f"historical_prices is {type(hp_raw).__name__}, not dict"]

    cleaned = {}
    removed = []
    for date_str, close in hp_raw.items():
        if not isinstance(date_str, str) or len(date_str) < 8:
            removed.append(f"bad-date-key:{repr(date_str)}")
            continue
        if not is_finite_number(close):
            removed.append(date_str)
            continue
        cleaned[date_str] = close
    return cleaned, removed


def is_valid_ticker_record(entry) -> bool:
    """
    Check that a ticker record has the structure expected by app.js:
      { "metadata": {...}, "historical_prices": {...} }
    Both keys must be present and must be dicts (historical_prices may be empty).
    """
    if not isinstance(entry, dict):
        return False
    if "metadata" not in entry or not isinstance(entry["metadata"], dict):
        return False
    hp = entry.get("historical_prices")
    if not isinstance(hp, dict):
        return False
    return True


def load_last_good() -> dict:
    """
    Load the current production file as the last-good dataset.
    Returns an empty dict if the file does not exist or cannot be parsed.
    """
    if not os.path.isfile(PRODUCTION_FILE):
        return {}
    try:
        data = load_lenient(PRODUCTION_FILE)
        if not isinstance(data, dict):
            return {}
        # Filter to only structurally valid records
        return {sym: entry for sym, entry in data.items()
                if is_valid_ticker_record(entry)}
    except Exception as exc:
        print(f"  WARNING: Could not load last-good data: {exc}")
        return {}


# ── Per-ticker fetch ─────────────────────────────────────────────────────────

def fetch_ticker(symbol: str) -> tuple[bool, dict | None, list[str]]:
    """
    Download data for a single ticker using yfinance.

    Returns (success: bool, record: dict|None, warnings: list[str]).
    On success, record is a validated { metadata, historical_prices } dict.
    On failure, record is None.
    """
    warnings = []
    try:
        import yfinance as yf
        ticker = yf.Ticker(symbol)
        info = ticker.info or {}

        def get_stat(key):
            return info.get(key, None)

        summary = get_stat('longBusinessSummary')
        if isinstance(summary, str) and summary:
            sentences = summary.split('. ')
            summary = '. '.join(sentences[:2])
            if summary and not summary.endswith('.'):
                summary += '.'

        current_price = get_stat('currentPrice')
        if current_price is None:
            current_price = get_stat('regularMarketPrice')

        metadata = {
            "longName":             get_stat('longName'),
            "sector":               get_stat('sector'),
            "longBusinessSummary":  summary,
            "currentPrice":         sanitise_scalar(current_price),
            "marketCap":            sanitise_scalar(get_stat('marketCap')),
            "trailingPE":           sanitise_scalar(get_stat('trailingPE')),
            "fiftyTwoWeekHigh":     sanitise_scalar(get_stat('fiftyTwoWeekHigh')),
            "fiftyTwoWeekLow":      sanitise_scalar(get_stat('fiftyTwoWeekLow')),
        }

        history = ticker.history(period="1y")
        historical_prices = {}
        if history is not None and not history.empty:
            for date, row in history.iterrows():
                date_str = date.strftime('%Y-%m-%d')
                close = row.get('Close')
                if is_finite_number(close):
                    historical_prices[date_str] = round(float(close), 2)
                else:
                    warnings.append(f"skipped {date_str}: close={repr(close)}")
        else:
            warnings.append("history.empty — no price observations retrieved")

        record = {
            "metadata": metadata,
            "historical_prices": historical_prices,
        }

        if not is_valid_ticker_record(record):
            return False, None, warnings + ["resulting record failed structure check"]

        return True, record, warnings

    except Exception as exc:
        return False, None, [f"exception: {exc}"]


# ── Serialise and validate ───────────────────────────────────────────────────

def write_and_validate_candidate(data: dict) -> tuple[bool, str]:
    """
    Serialise data to CANDIDATE_FILE with strict JSON (allow_nan=False).
    Reopen and validate.  Return (ok, error_message).
    """
    try:
        candidate_str = json.dumps(data, indent=4, allow_nan=False)
    except ValueError as exc:
        return False, f"Serialisation failed: {exc}"

    try:
        with open(CANDIDATE_FILE, "w", encoding="utf-8") as fh:
            fh.write(candidate_str)
    except OSError as exc:
        return False, f"Could not write candidate: {exc}"

    # Strict re-parse
    try:
        with open(CANDIDATE_FILE, "r", encoding="utf-8") as fh:
            raw = fh.read()
        json.loads(raw)
    except json.JSONDecodeError as exc:
        return False, f"Candidate is not valid strict JSON: {exc}"

    # Token check
    if re.search(r'\bNaN\b|\bInfinity\b', raw):
        return False, "Non-finite token (NaN/Infinity) found in candidate"

    return True, ""


# ── Main refresh logic ───────────────────────────────────────────────────────

def fetch_equity_data():
    start_time = datetime.now(timezone.utc)
    print("=" * 66)
    print("KUTUN TERMINAL — equity_engine.py  (Stage 1B hardened refresh)")
    print(f"Started: {start_time.isoformat()}")
    print(f"MIN_VALID_TICKERS threshold: {MIN_VALID_TICKERS}")
    print("=" * 66)

    dry_run = "--dry-run" in sys.argv
    if dry_run:
        print("\n[DRY RUN] Validating current production file only. No downloads.")
        if os.path.isfile(PRODUCTION_FILE):
            ok, err = write_and_validate_candidate(load_lenient(PRODUCTION_FILE))
            if ok:
                print("  ✓ Current production file is valid strict JSON.")
            else:
                print(f"  ✗ Validation failed: {err}")
            if os.path.isfile(CANDIDATE_FILE):
                os.remove(CANDIDATE_FILE)
        else:
            print(f"  Production file not found: {PRODUCTION_FILE}")
        return

    # ── Step 1: load last-good dataset ────────────────────────────────────
    print("\n[1] Loading last-good dataset …")
    last_good = load_last_good()
    print(f"    {len(last_good)} valid tickers in last-good snapshot.")

    # ── Step 2: per-ticker refresh ────────────────────────────────────────
    print(f"\n[2] Refreshing {len(TARGET_TICKERS)} tickers …")
    result_data    = {}
    refreshed      = []
    fallback_used  = []
    excluded       = []
    ticker_warnings = {}

    for sym in TARGET_TICKERS:
        print(f"  Fetching {sym} …", end=" ", flush=True)
        ok, record, warns = fetch_ticker(sym)

        if ok:
            result_data[sym] = record
            refreshed.append(sym)
            if warns:
                ticker_warnings[sym] = warns
            print(f"OK ({len(record['historical_prices'])} obs)")
        else:
            # Attempt last-good fallback
            if sym in last_good:
                result_data[sym] = last_good[sym]
                fallback_used.append(sym)
                ticker_warnings[sym] = warns
                print(f"FALLBACK (last-good preserved)  Reason: {warns[-1] if warns else 'unknown'}")
            else:
                excluded.append(sym)
                ticker_warnings[sym] = warns
                print(f"EXCLUDED (no fallback)  Reason: {warns[-1] if warns else 'unknown'}")

        time.sleep(REQUEST_DELAY_S)

    valid_count = len(result_data)
    print(f"\n  Requested: {len(TARGET_TICKERS)} | Refreshed: {len(refreshed)} | Fallback: {len(fallback_used)} | Excluded: {len(excluded)}")

    # ── Step 3: minimum-ticker check ──────────────────────────────────────
    if valid_count < MIN_VALID_TICKERS:
        print(f"\n[3] REJECTED — only {valid_count} valid tickers, below threshold {MIN_VALID_TICKERS}.")
        print("    Production file left untouched.")
        _write_meta(start_time, refreshed, fallback_used, excluded, {}, ticker_warnings, replaced=False, reason=f"below MIN_VALID_TICKERS ({valid_count}<{MIN_VALID_TICKERS})")
        sys.exit(1)

    # ── Step 4: write and validate candidate ──────────────────────────────
    print(f"\n[3] Writing and validating candidate …")
    ok, err = write_and_validate_candidate(result_data)
    if not ok:
        print(f"    VALIDATION FAILED: {err}")
        print("    Production file left untouched.")
        _write_meta(start_time, refreshed, fallback_used, excluded, result_data, ticker_warnings, replaced=False, reason=err)
        sys.exit(1)
    print("    ✓ Candidate validated (strict JSON, no NaN/Infinity).")

    # ── Step 5: atomic replacement ────────────────────────────────────────
    print(f"\n[4] Replacing production file …")
    try:
        os.replace(CANDIDATE_FILE, PRODUCTION_FILE)
    except OSError as exc:
        print(f"    ERROR: os.replace failed: {exc}")
        sys.exit(1)
    print(f"    ✓ {PRODUCTION_FILE} replaced atomically.")

    # ── Step 6: compute date stats ────────────────────────────────────────
    latest_by_ticker = {}
    all_dates = []
    for sym, entry in result_data.items():
        hp = entry.get("historical_prices", {})
        if hp:
            dates = sorted(hp.keys())
            latest_by_ticker[sym] = dates[-1]
            all_dates.extend(dates)
    all_dates.sort()

    # ── Step 7: sidecar metadata ──────────────────────────────────────────
    _write_meta(start_time, refreshed, fallback_used, excluded, result_data, ticker_warnings,
                replaced=True, latest_by_ticker=latest_by_ticker, all_dates=all_dates)

    # ── Summary ───────────────────────────────────────────────────────────
    print("\n" + "=" * 66)
    print("REFRESH COMPLETE")
    print(f"  Requested tickers      : {len(TARGET_TICKERS)}")
    print(f"  Successfully refreshed : {len(refreshed)}")
    print(f"  Last-good fallbacks    : {len(fallback_used)}")
    print(f"  Excluded tickers       : {len(excluded)}")
    if all_dates:
        print(f"  Earliest observation   : {all_dates[0]}")
        print(f"  Latest observation     : {all_dates[-1]}")
    print(f"  Output                 : {os.path.abspath(PRODUCTION_FILE)}")
    print(f"  Production replaced    : YES")
    if excluded:
        print(f"\n  Excluded tickers:")
        for t in excluded:
            print(f"    - {t}: {ticker_warnings.get(t, [])[-1] if ticker_warnings.get(t) else 'unknown'}")
    print("=" * 66)


def _write_meta(start_time, refreshed, fallback_used, excluded, result_data,
                warnings, replaced: bool, reason: str = "",
                latest_by_ticker: dict = None, all_dates: list = None):
    """Write the sidecar equity_data_meta.json file."""
    doc = {
        "source": "equity_engine.py (yfinance, Stage 1B hardened refresh)",
        "methodology_version": SCRIPT_VERSION,
        "utc_retrieval_timestamp": start_time.isoformat(),
        "utc_completion_timestamp": datetime.now(timezone.utc).isoformat(),
        "production_replaced": replaced,
        "replacement_rejected_reason": reason if not replaced else None,
        "counts": {
            "requested": len(refreshed) + len(fallback_used) + len(excluded),
            "refreshed": len(refreshed),
            "fallback": len(fallback_used),
            "excluded": len(excluded),
        },
        "earliest_valid_date": all_dates[0] if all_dates else None,
        "latest_valid_date": all_dates[-1] if all_dates else None,
        "latest_obs_by_ticker": latest_by_ticker or {},
        "excluded_tickers": excluded,
        "fallback_tickers": fallback_used,
        "refresh_warnings": {sym: w for sym, w in warnings.items() if w},
    }
    try:
        meta_str = json.dumps(doc, indent=4, allow_nan=False)
        with open(META_FILE, "w", encoding="utf-8") as fh:
            fh.write(meta_str)
    except Exception as exc:
        print(f"  WARNING: Could not write {META_FILE}: {exc}")


if __name__ == "__main__":
    fetch_equity_data()
