"""
sector_candidate_compare.py - Kutun Terminal Stage 2D2 (read-only review tool)
=============================================================================
Compares a candidate sector dataset with the current production dataset BY DATE.

* Inputs are only read. The only files written are the explicit --out-json / --out-md paths,
  which must not be any input path and must not be inside the application folder.
* No provider request, no collector import, no network. Importing performs no I/O.
* Comparison is by calendar date, never by array index. Each ETF is compared independently.
* Nothing here proves why a date is absent or why a price differs. Measured facts
  (counts, dates, statistics) are kept apart from hypotheses (labelled "diagnostic").
* Calendar-gap figures are a screen on dates present in the files; they are NOT
  verified missing-session detection.

Conventions (stated so the numbers can be audited)
  revision          candidate price != production price on a shared date
  exact count       |difference| > 1e-9 (stored values are 2-decimal numbers)
  tolerance count   |difference| > ABS_TOLERANCE (0.01 = one stored cent), disclosed separately
  relative revision (candidate - production) / production   (DENOMINATOR = production price)
  removed date      in production, absent from the candidate:
                      "before candidate start"  < candidate first date
                      "internal"                between candidate first and last dates
                      "after candidate end"     > candidate last date
  repeat screen     consecutive identical production prices where the candidate moved by more
                    than REPEAT_MIN_CANDIDATE_MOVE (0.5%) between the same two dates - a screen
                    for possible fill, not a finding. Smaller candidate moves are counted
                    separately as consistent with 2-decimal rounding.

Event coverage is NOT computed here: sector_event_coverage.js runs the production
JavaScript. compare_event_coverage() only diffs that harness's output.
"""
import argparse
import csv
import hashlib
import json
import math
import os
import statistics
import sys
from datetime import date

ABS_TOLERANCE = 0.01
EXACT_EPS = 1e-9
GAP_WARN_DAYS = 7
ADJ_RESIDUAL_TOLERANCE = 0.011        # one stored cent plus slack for the estimated ratio
HORIZONS = ("T+1", "T+5", "T+22", "T+252")
# Repeat screen: a production repeat counts only if the candidate moved by more than this
# fraction between the same two dates (2-decimal rounding of a low price can hide small moves).
REPEAT_MIN_CANDIDATE_MOVE = 0.005


# ------------------------------------------------------------------ loading --

def _no_constant(name):
    raise ValueError("non-finite JSON constant %s" % name)


def _no_dupes(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise ValueError("duplicate key %r" % k)
        out[k] = v
    return out


def read_json_strict(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    return json.loads(raw.decode("utf-8"), parse_constant=_no_constant, object_pairs_hook=_no_dupes)


def sha256_file(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest().upper()


def _valid_date(s):
    if not isinstance(s, str) or len(s) != 10:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def points_to_map(points):
    """[{x,y}] -> ({date: price}, problems). Null/non-finite/non-numeric prices are excluded and counted."""
    problems = {"invalid_date": [], "duplicate_date": [], "unusable_price": 0, "malformed": 0}
    out = {}
    if not isinstance(points, list):
        return out, dict(problems, malformed=1)
    for rec in points:
        if not isinstance(rec, dict):
            problems["malformed"] += 1
            continue
        d, p = rec.get("x"), rec.get("y")
        if _valid_date(d) is None:
            problems["invalid_date"].append(d)
            continue
        if d in out or d in problems["duplicate_date"]:
            problems["duplicate_date"].append(d)
            out.pop(d, None)
            continue
        if isinstance(p, bool) or not isinstance(p, (int, float)) or not math.isfinite(p):
            problems["unusable_price"] += 1
            continue
        out[d] = float(p)
    return out, problems


# --------------------------------------------------------------- statistics --

def _median(xs):
    return statistics.median(xs) if xs else None


def gap_summary(dates, top=3):
    ds = sorted(_valid_date(d) for d in dates)
    gaps = []
    for a, b in zip(ds, ds[1:]):
        n = (b - a).days
        gaps.append((n, a.isoformat(), b.isoformat()))
    gaps.sort(reverse=True)
    return {"largest": [{"days": n, "from": a, "to": b} for n, a, b in gaps[:top]],
            "over_%d_days" % GAP_WARN_DAYS: sum(1 for g in gaps if g[0] > GAP_WARN_DAYS)}


def annual_counts(dates):
    out = {}
    for d in dates:
        out[d[:4]] = out.get(d[:4], 0) + 1
    return dict(sorted(out.items()))


def leading_identical_run(dates_sorted, pmap):
    """Length of the run of identical values at the very start (including the first distinct-from-fill value)."""
    if not dates_sorted:
        return 0
    first = pmap[dates_sorted[0]]
    n = 0
    for d in dates_sorted:
        if pmap[d] == first:
            n += 1
        else:
            break
    return n


def _sample(lst, k=5):
    return lst[:k]


def compare_series(prod_points, cand_points, abs_tol=ABS_TOLERANCE, adj_map=None):
    pm, pprob = points_to_map(prod_points)
    cm, cprob = points_to_map(cand_points)
    pd_, cd_ = sorted(pm), sorted(cm)
    res = {
        "input_problems": {"production": pprob, "candidate": cprob},
        "production": {"records": len(pd_), "first": pd_[0] if pd_ else None, "last": pd_[-1] if pd_ else None},
        "candidate": {"records": len(cd_), "first": cd_[0] if cd_ else None, "last": cd_[-1] if cd_ else None},
        "tolerance": {"exact_epsilon": EXACT_EPS, "absolute_tolerance": abs_tol,
                      "relative_denominator": "production price"},
    }
    shared = sorted(set(pm) & set(cm))
    added = sorted(set(cm) - set(pm))
    removed = sorted(set(pm) - set(cm))
    cfirst, clast = res["candidate"]["first"], res["candidate"]["last"]
    rem_before = [d for d in removed if cfirst is not None and d < cfirst]
    rem_after = [d for d in removed if clast is not None and d > clast]
    _edge = set(rem_before) | set(rem_after)
    rem_internal = [d for d in removed if d not in _edge]
    if cfirst is None:                       # empty candidate: every removed date is "no candidate"
        rem_before, rem_after, rem_internal = [], [], list(removed)
    res["dates"] = {
        "shared": len(shared),
        "added": {"count": len(added), "first": added[0] if added else None, "last": added[-1] if added else None,
                  "before_production_first": sum(1 for d in added if pd_ and d < pd_[0]),
                  "after_production_last": sum(1 for d in added if pd_ and d > pd_[-1]),
                  "internal": sum(1 for d in added if pd_ and pd_[0] < d < pd_[-1])},
        "removed": {"count": len(removed), "before_candidate_start": len(rem_before),
                    "internal": len(rem_internal), "after_candidate_end": len(rem_after),
                    "first": removed[0] if removed else None, "last": removed[-1] if removed else None,
                    "internal_sample": _sample(rem_internal)},
    }
    # revisions on shared dates
    revs = []
    for d in shared:
        diff = cm[d] - pm[d]
        rel = (diff / pm[d]) if pm[d] != 0 else None
        revs.append((d, pm[d], cm[d], diff, rel))
    exact = [r for r in revs if abs(r[3]) > EXACT_EPS]
    tol = [r for r in revs if round(abs(r[3]), 6) > abs_tol]
    absdiffs = [abs(r[3]) for r in exact]
    rels = [abs(r[4]) for r in exact if r[4] is not None]
    mx_abs = max(exact, key=lambda r: abs(r[3])) if exact else None
    mx_rel = max((r for r in exact if r[4] is not None), key=lambda r: abs(r[4]), default=None)
    by_year = {}
    for d, p, c, diff, rel in revs:
        y = by_year.setdefault(d[:4], {"shared": 0, "revised": 0, "_rel": []})
        y["shared"] += 1
        if abs(diff) > EXACT_EPS:
            y["revised"] += 1
            if rel is not None:
                y["_rel"].append(rel)
    pattern = {y: {"shared": v["shared"], "revised": v["revised"],
                   "median_signed_relative_pct": round(_median(v["_rel"]) * 100, 3) if v["_rel"] else None}
               for y, v in sorted(by_year.items())}
    res["revisions"] = {
        "shared_dates": len(shared),
        "exact_count": len(exact), "tolerance_count": len(tol),
        "unchanged_count": len(shared) - len(exact),
        "candidate_higher": sum(1 for r in exact if r[3] > 0), "candidate_lower": sum(1 for r in exact if r[3] < 0),
        "first_revised": exact[0][0] if exact else None, "last_revised": exact[-1][0] if exact else None,
        "median_abs": round(_median(absdiffs), 6) if absdiffs else None,
        "max_abs": {"value": round(abs(mx_abs[3]), 6), "date": mx_abs[0], "production": mx_abs[1], "candidate": mx_abs[2]} if mx_abs else None,
        "median_rel_pct": round(_median(rels) * 100, 4) if rels else None,
        "max_rel_pct": {"value": round(abs(mx_rel[4]) * 100, 4), "date": mx_rel[0], "production": mx_rel[1], "candidate": mx_rel[2]} if mx_rel else None,
        "by_year": pattern,
        "largest_samples": [{"date": r[0], "production": r[1], "candidate": r[2]}
                            for r in sorted(exact, key=lambda r: -abs(r[3]))[:5]],
    }
    # gaps, annual counts
    res["gaps"] = {"production": gap_summary(pd_), "candidate": gap_summary(cd_)}
    res["annual_counts"] = {"production": annual_counts(pd_), "candidate": annual_counts(cd_)}
    # production leading identical run and what the candidate says about it
    run = leading_identical_run(pd_, pm)
    run_dates = pd_[:run]
    res["production_leading_identical_run"] = {
        "length": run, "first": run_dates[0] if run_dates else None, "last": run_dates[-1] if run_dates else None,
        "value": pm[run_dates[0]] if run_dates else None,
        "dates_absent_from_candidate": sum(1 for d in run_dates if d not in cm),
        "dates_present_in_candidate": sum(1 for d in run_dates if d in cm),
    }
    # repeat screen (outside the leading run)
    rep = []
    rounding_only = 0
    for i, (a, b) in enumerate(zip(pd_, pd_[1:])):
        if pm[a] == pm[b] and a in cm and b in cm and cm[a] != cm[b] and i >= run - 1:
            move = abs(cm[b] / cm[a] - 1) if cm[a] else None
            if move is not None and move > REPEAT_MIN_CANDIDATE_MOVE:
                rep.append((a, b, pm[a], cm[a], cm[b]))
            else:
                rounding_only += 1
    adj_also = None
    if adj_map is not None:                       # does the fresh Adj Close repeat on the same two dates?
        adj_also = sum(1 for a, b, _, _, _ in rep if a in adj_map and b in adj_map
                       and abs(adj_map[b] - adj_map[a]) <= ADJ_RESIDUAL_TOLERANCE)
    res["repeat_screen"] = {"production_repeats_where_candidate_differs": len(rep),
                            "candidate_move_threshold": REPEAT_MIN_CANDIDATE_MOVE,
                            "repeats_with_small_candidate_move_treated_as_rounding": rounding_only,
                            "of_those_fresh_adj_close_also_repeats": adj_also,
                            "unexplained_by_fresh_adj_close": None if adj_also is None else len(rep) - adj_also,
                            "sample": [{"dates": [a, b], "production": p, "candidate": [ca, cb]} for a, b, p, ca, cb in rep[:5]]}
    return res


def adjustment_diagnostic(prod_points, close_map, adj_map):
    """
    DIAGNOSTIC ONLY (not used to alter the candidate). Is production proportional to the
    provider's Adj Close, or to Close, over their shared dates? A constant ratio (spread within
    rounding) means the two series differ by one scale factor.
    """
    pm, _ = points_to_map(prod_points)

    def stat(other):
        ds = [d for d in sorted(pm) if d in other and other[d] and other[d] > 0]
        if not ds:
            return None
        ratios = [pm[d] / other[d] for d in ds]
        med = _median(ratios)
        resid = [abs(pm[d] - other[d] * med) for d in ds]
        return {"dates": len(ds), "median_ratio": round(med, 6), "min_ratio": round(min(ratios), 6),
                "max_ratio": round(max(ratios), 6),
                "ratio_spread_pct": round((max(ratios) - min(ratios)) / med * 100, 4),
                "within_residual_tolerance": sum(1 for r in resid if r <= ADJ_RESIDUAL_TOLERANCE),
                "max_residual": round(max(resid), 4), "residual_tolerance": ADJ_RESIDUAL_TOLERANCE}
    return {"vs_candidate_Close": stat(close_map), "vs_candidate_Adj_Close": stat(adj_map),
            "note": "measured proportionality only; it does not establish the settings used to build production"}


# ------------------------------------------------------------ raw frame csv --

def read_raw_frame(path):
    """Provider frame saved by the 2D2 driver (3 header rows: field, ticker, Date). -> {field: {ticker: {date: float|None}}}"""
    with open(path, newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    fields, tickers = rows[0][1:], rows[1][1:]
    out = {}
    for r in rows[3:]:
        d = r[0][:10]
        for (f, t), v in zip(zip(fields, tickers), r[1:]):
            out.setdefault(f, {}).setdefault(t, {})[d] = float(v) if v not in ("", "nan", "NaN") else None
    return out


def raw_evidence(frame, ticker):
    close = frame.get("Close", {}).get(ticker, {})
    ds = sorted(close)
    valid = [d for d in ds if close[d] is not None]
    nan_leading = 0
    for d in ds:
        if close[d] is None:
            nan_leading += 1
        else:
            break
    return {"rows_in_frame": len(ds), "close_nan": sum(1 for d in ds if close[d] is None),
            "close_nan_leading": nan_leading, "close_nan_internal_or_trailing": sum(1 for d in ds if close[d] is None) - nan_leading,
            "first_valid_close": valid[0] if valid else None, "last_valid_close": valid[-1] if valid else None,
            "adj_close_nan": sum(1 for v in frame.get("Adj Close", {}).get(ticker, {}).values() if v is None)}


# ------------------------------------------------------------ whole dataset --

def candidate_status(sidecar, sym):
    if not sidecar:
        return {"status": "unknown (no sidecar supplied)", "provenance": None, "reasons": [], "review_required": None}
    rec = (sidecar.get("instruments") or {}).get(sym)
    if not rec:
        return {"status": "unknown (not in sidecar)", "provenance": None, "reasons": [], "review_required": None}
    return {"status": rec.get("status"), "provenance": rec.get("provenance"),
            "reasons": rec.get("reasons", []), "review_required": rec.get("review_required"),
            "last_successful_refresh_utc": rec.get("last_successful_refresh_utc"),
            "removed_rows": (rec.get("attempt") or {}).get("removed_rows"),
            "removed_position": (rec.get("attempt") or {}).get("removed_position")}


def compare_datasets(prod_doc, cand_doc, sidecar=None, frame=None, abs_tol=ABS_TOLERANCE):
    out = {"tickers": {}}
    for sym in sorted(set(prod_doc) | set(cand_doc), key=lambda s: list(prod_doc).index(s) if s in prod_doc else 999):
        adj = None
        if frame is not None:
            adj = {d: v for d, v in frame.get("Adj Close", {}).get(sym, {}).items() if v is not None}
        r = compare_series(prod_doc.get(sym), cand_doc.get(sym), abs_tol, adj_map=adj)
        r["status"] = candidate_status(sidecar, sym)
        r["in_production"], r["in_candidate"] = sym in prod_doc, sym in cand_doc
        if frame is not None:
            r["raw_provider_evidence"] = raw_evidence(frame, sym)
            r["adjustment_diagnostic"] = adjustment_diagnostic(
                prod_doc.get(sym), {d: v for d, v in frame.get("Close", {}).get(sym, {}).items() if v is not None},
                {d: v for d, v in frame.get("Adj Close", {}).get(sym, {}).items() if v is not None})
        out["tickers"][sym] = r
    return out


# ----------------------------------------------------------- event coverage --

def _cell_state(p, c):
    pa = bool(p and p.get("available"))
    ca = bool(c and c.get("available"))
    if pa and ca:
        return "available_both"
    if pa and not ca:
        return "available_to_unavailable"
    if ca and not pa:
        return "unavailable_to_available"
    return "unavailable_both"


def compare_event_coverage(cov, prod_label="production", cand_label="candidate"):
    """Diff of sector_event_coverage.js output (the production JS did the calculation)."""
    index = {}
    for r in cov["rows"]:
        index[(r["dataset"], r["event"], r["ticker"])] = r
    keys = sorted({(e, t) for (_, e, t) in index})
    order_e = {e["name"]: i for i, e in enumerate(cov["events"])}
    keys.sort(key=lambda k: (order_e.get(k[0], 99), cov["tickers"].index(k[1]) if k[1] in cov["tickers"] else 99))
    summary = {"row_states": {}, "horizon_states": {h: {} for h in HORIZONS}, "by_ticker": {},
               "overlap_pct_point_changes": {h: [] for h in HORIZONS}}
    cells, row_changes = [], []
    for ev, tk in keys:
        p, c = index.get((prod_label, ev, tk)), index.get((cand_label, ev, tk))
        rs = "%s->%s" % (p["row"] if p else "absent", c["row"] if c else "absent")
        summary["row_states"][rs] = summary["row_states"].get(rs, 0) + 1
        bt = summary["by_ticker"].setdefault(tk, {"events": 0, "rows_prod": 0, "rows_cand": 0,
                                                  **{"%s_%s" % (h, w): 0 for h in HORIZONS for w in ("prod", "cand")}})
        bt["events"] += 1
        bt["rows_prod"] += 1 if p and p["row"] == "shown" else 0
        bt["rows_cand"] += 1 if c and c["row"] == "shown" else 0
        if rs not in ("shown->shown",):
            row_changes.append({"event": ev, "eventDate": (p or c)["eventDate"], "ticker": tk, "production": p and p["row"],
                                "candidate": c and c["row"], "production_baseline": p and p.get("baseline"),
                                "candidate_baseline": c and c.get("baseline"), "candidate_reason": c and c.get("reason"),
                                "production_reason": p and p.get("reason")})
        for h in HORIZONS:
            ph = (p or {}).get("horizons") and p["horizons"].get(h)
            ch = (c or {}).get("horizons") and c["horizons"].get(h)
            if ph and ph.get("available"):
                bt["%s_prod" % h] += 1
            if ch and ch.get("available"):
                bt["%s_cand" % h] += 1
            st = _cell_state(ph, ch)
            if (p and p["row"] == "omitted") and (c and c["row"] == "omitted"):
                st = "row omitted in both"
            summary["horizon_states"][h][st] = summary["horizon_states"][h].get(st, 0) + 1
            if st == "available_both":
                same_end = ph["endpointDate"] == ch["endpointDate"]
                delta = ch["pct"] - ph["pct"]
                summary["overlap_pct_point_changes"][h].append(abs(delta))
                cells.append({"event": ev, "ticker": tk, "horizon": h, "state": st, "same_endpoint": same_end,
                              "production": [ph["endpointDate"], round(ph["pct"], 3)],
                              "candidate": [ch["endpointDate"], round(ch["pct"], 3)], "delta_pp": round(delta, 3),
                              "baseline": [(p["baseline"] or {}).get("date"), (c["baseline"] or {}).get("date")]})
            elif st in ("available_to_unavailable", "unavailable_to_available"):
                cells.append({"event": ev, "ticker": tk, "horizon": h, "state": st,
                              "production": ph and [ph.get("endpointDate"), ph.get("pct") and round(ph["pct"], 3), ph.get("reason")],
                              "candidate": ch and [ch.get("endpointDate"), ch.get("pct") and round(ch["pct"], 3), ch.get("reason")],
                              "baseline": [(p and p.get("baseline") or {}).get("date"), (c and c.get("baseline") or {}).get("date")]})
    overlap = {}
    for h, xs in summary["overlap_pct_point_changes"].items():
        overlap[h] = {"cells": len(xs), "median_abs_pp": round(_median(xs), 3) if xs else None,
                      "max_abs_pp": round(max(xs), 3) if xs else None,
                      "over_0.5pp": sum(1 for x in xs if x > 0.5), "over_1pp": sum(1 for x in xs if x > 1.0)}
    summary["overlap_pct_point_changes"] = overlap
    return {"summary": summary, "row_changes": row_changes, "cell_changes": cells,
            "baseline_age_limit_days": cov.get("max_event_baseline_age_days"),
            "offsets_note": "production applies observation-count offsets (T+1/5/22/252) from the baseline observation"}


# ----------------------------------------------------------------- markdown --

def render_markdown(cmp_result, events=None):
    L = []
    t = cmp_result["tickers"]
    L.append("| ETF | status (sidecar) | prod records | cand records | prod first..last | cand first..last | added | removed (before start / internal / after end) |")
    L.append("|---|---|---:|---:|---|---|---:|---|")
    for s, r in t.items():
        rem = r["dates"]["removed"]
        L.append("| %s | %s | %d | %d | %s..%s | %s..%s | %d | %d (%d / %d / %d) |" % (
            s, r["status"]["status"], r["production"]["records"], r["candidate"]["records"], r["production"]["first"],
            r["production"]["last"], r["candidate"]["first"], r["candidate"]["last"], r["dates"]["added"]["count"],
            rem["count"], rem["before_candidate_start"], rem["internal"], rem["after_candidate_end"]))
    L.append("")
    L.append("| ETF | shared | revised exact | revised > %.2f | unchanged | cand higher / lower | median abs | max abs (date) | median rel %% | max rel %% (date) | revised range |" % ABS_TOLERANCE)
    L.append("|---|---:|---:|---:|---:|---|---:|---|---:|---|---|")
    for s, r in t.items():
        v = r["revisions"]
        ma, mr = v["max_abs"], v["max_rel_pct"]
        L.append("| %s | %d | %d | %d | %d | %d / %d | %s | %s | %s | %s | %s..%s |" % (
            s, v["shared_dates"], v["exact_count"], v["tolerance_count"], v["unchanged_count"], v["candidate_higher"],
            v["candidate_lower"], v["median_abs"], ("%.2f (%s)" % (ma["value"], ma["date"])) if ma else "-",
            v["median_rel_pct"], ("%.2f (%s)" % (mr["value"], mr["date"])) if mr else "-", v["first_revised"], v["last_revised"]))
    L.append("")
    L.append("| ETF | largest gaps, prod (days: from..to) | largest gaps, cand | gaps > %d d (prod / cand) | prod leading identical run | its dates absent from candidate | repeat-screen hits |" % GAP_WARN_DAYS)
    L.append("|---|---|---|---|---:|---:|---:|")
    for s, r in t.items():
        g = r["gaps"]
        fm = lambda gg: "; ".join("%d: %s..%s" % (x["days"], x["from"], x["to"]) for x in gg["largest"][:2])
        key = "over_%d_days" % GAP_WARN_DAYS
        run = r["production_leading_identical_run"]
        L.append("| %s | %s | %s | %d / %d | %d | %d | %d |" % (
            s, fm(g["production"]), fm(g["candidate"]), g["production"][key], g["candidate"][key], run["length"],
            run["dates_absent_from_candidate"], r["repeat_screen"]["production_repeats_where_candidate_differs"]))
    return "\n".join(L)


# ---------------------------------------------------------------------- CLI --

def _inside_app_folder(path):
    d = os.path.dirname(os.path.abspath(path))
    return os.path.exists(os.path.join(d, "index.html")) or os.path.exists(os.path.join(d, "app.js"))


def build_parser():
    p = argparse.ArgumentParser(prog="sector_candidate_compare.py", description="Read-only date-based sector candidate comparison.")
    p.add_argument("--production", required=True, help="production sector_historical.json (read only)")
    p.add_argument("--candidate", required=True, help="candidate sector_historical.json (read only)")
    p.add_argument("--sidecar", help="candidate sector_historical_meta.json (read only)")
    p.add_argument("--raw-frame", help="saved provider frame CSV (read only) for raw evidence and the adjustment diagnostic")
    p.add_argument("--events-coverage", help="output of sector_event_coverage.js (read only)")
    p.add_argument("--out-json", required=True)
    p.add_argument("--out-md", help="optional compact tables")
    return p


def main(argv=None):
    a = build_parser().parse_args(argv)
    inputs = [a.production, a.candidate] + [x for x in (a.sidecar, a.raw_frame, a.events_coverage) if x]
    outs = [x for x in (a.out_json, a.out_md) if x]
    real_in = {os.path.realpath(x) for x in inputs}
    for o in outs:
        if os.path.realpath(o) in real_in:
            print("REFUSED: output path equals an input path: %s" % o)
            return 3
        if _inside_app_folder(o):
            print("REFUSED: output path is inside the application folder: %s" % o)
            return 3
    before = {x: sha256_file(x) for x in inputs}
    prod, cand = read_json_strict(a.production), read_json_strict(a.candidate)
    sidecar = read_json_strict(a.sidecar) if a.sidecar else None
    frame = read_raw_frame(a.raw_frame) if a.raw_frame else None
    result = compare_datasets(prod, cand, sidecar, frame)
    result["inputs"] = {x: {"sha256": h} for x, h in before.items()}
    if a.events_coverage:
        result["event_coverage"] = compare_event_coverage(read_json_strict(a.events_coverage))
    after = {x: sha256_file(x) for x in inputs}
    result["inputs_unchanged"] = before == after
    with open(a.out_json, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=1, allow_nan=False)
    if a.out_md:
        with open(a.out_md, "w", encoding="utf-8") as fh:
            fh.write(render_markdown(result) + "\n")
    print("wrote %s (inputs unchanged: %s)" % (a.out_json, result["inputs_unchanged"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
