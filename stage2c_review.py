"""
stage2c_review.py - Kutun Terminal Stage 2C1
============================================
Controlled commodity download into a STAGING directory, plus a read-only comparison of
production, the previously inspected backup and the staged evidence. It never writes
outside the staging directory and refuses any staging layout whose dataset or sidecar
would resolve to a production path.

    py stage2c_review.py collect            # ONE bounded provider pass into a new staging dir
    py stage2c_review.py compare --staging staging_stage2c1_YYYYMMDD_HHMMSS [--baseline PATH]   # read-only report
        (--baseline: historical commodities_data.json; default evidence/commodities_data_pre_refresh_20260916.json)

collect:
  * creates staging_stage2c1_<UTC timestamp> under the project root (must not exist);
  * copies the current production commodities_data.json into it (production untouched);
  * calls commodity_tracker.run_refresh with the real provider adapter, output_dir = staging,
    download_options = {auto_adjust: False, price_field: "Close"}  (the definition of THIS
    experiment; it is not a statement about how existing saved files were produced);
  * keeps every returned response (dates + prices, invalid values encoded as strings so the
    evidence is strict JSON) in download_evidence.json, separate from the staged dataset;
  * runs the collector's own --verify against the staged output.
No retry is made: one yf.download call.

compare: for each instrument, by actual date, compares production (P), backup (B), the provider's
returned usable observations (R) and the staged output (S). Differences are exact (no tolerance);
a separate bucket reports differences at or below TOLERANCE_REPR (numerical representation).
Relative change uses |old| as the denominator, only where old != 0.
"""

import argparse
import json
import math
import os
import shutil
import statistics
import sys
from collections.abc import Mapping
from datetime import datetime, timezone

import commodity_tracker as ct
import coverage_audit as ca

STAGING_PREFIX = "staging_stage2c1_"
PRODUCTION_DATASET = ct.DATASET_FILE
# Default historical baseline: evidence/commodities_data_pre_refresh_20260916.json
# (SHA-256 D1BEDA347ECA8F0D6292DA61E951CE6957892EA61A53574B60D89ACF89B662EB).
# Override with --baseline PATH. No backup-folder name is assumed.
BACKUP_DATASET = os.path.join("evidence", "commodities_data_pre_refresh_20260916.json")
EXPERIMENT_OPTIONS = {"auto_adjust": False, "price_field": "Close"}
TOLERANCE_REPR = 1e-9            # differences at/below this are consistent with float representation
CENT = 0.01                      # prices are stored rounded to 2 decimals
EVIDENCE_FILE = "download_evidence.json"
REPORT_JSON = "comparison_report.json"
REPORT_MD = "comparison_tables.md"


# ------------------------------------------------------------------ safety --

def resolve_staging(root, staging_name):
    """Validate and return staging paths. Raises ValueError for anything touching production."""
    root_real = os.path.realpath(root)
    staging = os.path.realpath(os.path.join(root_real, staging_name))
    if os.path.dirname(staging) != root_real or not os.path.basename(staging).startswith(STAGING_PREFIX):
        raise ValueError("staging directory must be %s* directly under the project root" % STAGING_PREFIX)
    paths = {"staging": staging,
             "dataset": os.path.realpath(os.path.join(staging, ct.DATASET_FILE)),
             "sidecar": os.path.realpath(os.path.join(staging, ct.SIDECAR_FILE)),
             "evidence": os.path.realpath(os.path.join(staging, EVIDENCE_FILE))}
    prod = {os.path.realpath(os.path.join(root_real, n)) for n in
            (PRODUCTION_DATASET, ct.SIDECAR_FILE, "commodities_data_candidate.json")}
    for key in ("dataset", "sidecar", "evidence"):
        if paths[key] in prod or os.path.dirname(paths[key]) != staging:
            raise ValueError("%s path resolves outside staging or to a production path: %s" % (key, paths[key]))
    return paths


def encode_value(v):
    """Strict-JSON-safe encoding of one provider value for evidence files."""
    if v is None:
        return None
    if isinstance(v, bool):
        return "bool:%s" % v
    if isinstance(v, (int, float)):
        try:
            f = float(v)
        except OverflowError:
            return "Infinity" if v > 0 else "-Infinity"
        if math.isnan(f):
            return "NaN"
        if math.isinf(f):
            return "Infinity" if f > 0 else "-Infinity"
        return v
    if isinstance(v, str):
        return "str:" + v
    return "other:" + repr(v)


def write_json_strict(path, doc):
    payload = json.dumps(doc, indent=1, allow_nan=False).encode("utf-8")
    with open(path, "wb") as fh:
        fh.write(payload)
    with open(path, "rb") as fh:
        ct.strict_loads(fh.read())               # re-read with the strict parser
    return ct.sha256_hex(payload)


# --------------------------------------------------------------- comparison --

def series_map(entry):
    """{date: price} of valid-dated, finite-priced records (first occurrence wins) + skip counts."""
    out, skipped = {}, {"invalid_date": 0, "invalid_price": 0, "duplicate_date": 0}
    if not isinstance(entry, Mapping):
        return out, skipped
    for d, p in zip(entry.get("labels") or [], entry.get("prices") or []):
        if ct.parse_iso_date(d) is None:
            skipped["invalid_date"] += 1
        elif ct.classify_price(p)[0] != "ok":
            skipped["invalid_price"] += 1
        elif d in out:
            skipped["duplicate_date"] += 1
        else:
            out[d] = float(p)
    return out, skipped


def gap_summary(m):
    days = [ct.parse_iso_date(d) for d in sorted(m)]
    count, largest = ca._gap_stats(days)
    return {"gaps_over_7d": count, "largest_gap_days": largest["days"],
            "largest_gap": [largest["from"], largest["to"]] if largest["from"] else None}


def _median(xs):
    return statistics.median(xs) if xs else None


def diff_profile(old, new, sample=5):
    """Exact date-by-date comparison of two {date: price} maps (old -> new)."""
    shared = sorted(set(old) & set(new))
    added = sorted(set(new) - set(old))
    removed = sorted(set(old) - set(new))
    changed = [d for d in shared if new[d] != old[d]]
    diffs = {d: new[d] - old[d] for d in changed}
    absd = [abs(v) for v in diffs.values()]
    rel = [abs(diffs[d]) / abs(old[d]) for d in changed if old[d] != 0]
    by_year = {}
    for d in shared:
        y = by_year.setdefault(d[:4], {"shared": 0, "changed": 0, "abs": []})
        y["shared"] += 1
        if d in diffs:
            y["changed"] += 1
            y["abs"].append(abs(diffs[d]))
    top = sorted(changed, key=lambda d: abs(diffs[d]), reverse=True)[:sample]
    return {
        "old_records": len(old), "new_records": len(new), "shared_dates": len(shared),
        "added_dates": {"count": len(added), "first": added[0] if added else None, "last": added[-1] if added else None},
        "removed_dates": {"count": len(removed), "first": removed[0] if removed else None, "last": removed[-1] if removed else None},
        "changed_exact": len(changed),
        "changed_first": changed[0] if changed else None, "changed_last": changed[-1] if changed else None,
        "buckets_abs_change": {
            "<=tolerance(%g)" % TOLERANCE_REPR: sum(1 for a in absd if a <= TOLERANCE_REPR),
            "tolerance..<0.01": sum(1 for a in absd if TOLERANCE_REPR < a < CENT - TOLERANCE_REPR),
            ">=0.01": sum(1 for a in absd if a >= CENT - TOLERANCE_REPR)},   # a one-cent change is 0.00999... in floats
        "abs_change": {"median": _median(absd), "max": max(absd) if absd else None},
        "rel_change": {"denominator": "|old| (old != 0 only)", "n": len(rel),
                       "excluded_zero_denominator": len(changed) - len(rel),
                       "median": _median(rel), "max": max(rel) if rel else None},
        "signed_ratio_new_over_old": ({"min": min(new[d] / old[d] for d in changed if old[d] != 0),
                                       "median": _median([new[d] / old[d] for d in changed if old[d] != 0]),
                                       "max": max(new[d] / old[d] for d in changed if old[d] != 0)}
                                      if any(old[d] != 0 for d in changed) else None),
        "largest": [{"date": d, "old": old[d], "new": new[d], "diff": round(diffs[d], 6)} for d in top],
        "by_year": {y: {"shared": v["shared"], "changed": v["changed"],
                        "median_abs": _median(v["abs"]), "max_abs": max(v["abs"]) if v["abs"] else None}
                    for y, v in sorted(by_year.items()) if v["changed"]},
        "gaps_old": gap_summary(old), "gaps_new": gap_summary(new),
    }


def step_segments(old, new, top=5):
    """
    Pattern of the changes over the shared dates in order: maximal runs of consecutive shared
    dates whose cent-rounded difference is identical and non-zero (a 'step'), plus counts of
    unchanged runs. Descriptive only: a stepwise-constant difference is a measured pattern, not a cause.
    """
    shared = sorted(set(old) & set(new))
    segs, cur = [], None
    unchanged_runs, in_unchanged = 0, False
    for d in shared:
        diff = round(new[d] - old[d], 2)
        if diff == 0 and new[d] == old[d]:
            cur = None
            if not in_unchanged:
                unchanged_runs += 1
            in_unchanged = True
            continue
        in_unchanged = False
        if cur is not None and cur["diff"] == diff:
            cur["end"], cur["n"] = d, cur["n"] + 1
        else:
            cur = {"start": d, "end": d, "diff": diff, "n": 1}
            segs.append(cur)
    distinct = {}
    for s in segs:
        distinct[s["diff"]] = distinct.get(s["diff"], 0) + s["n"]
    ranked = sorted(distinct.items(), key=lambda kv: kv[1], reverse=True)
    return {"segments": len(segs), "unchanged_runs_between": unchanged_runs,
            "distinct_cent_rounded_differences": len(distinct),
            "most_common_differences": [{"diff": k, "dates": v} for k, v in ranked[:top]],
            "longest_segments": sorted(segs, key=lambda s: s["n"], reverse=True)[:top]}


def load_dataset(path):
    with open(path, "rb") as fh:
        data = ct.strict_loads(fh.read())
    if not isinstance(data, dict):
        raise ValueError("%s is not an object" % path)
    return data


def evidence_series(ev_entry):
    """{date: price} of the provider's returned usable observations from the evidence file."""
    if not isinstance(ev_entry, Mapping) or ev_entry.get("kind") != "response":
        return {}, {"invalid_date": 0, "invalid_price": 0, "duplicate_date": 0}
    return series_map({"labels": ev_entry["dates"], "prices": ev_entry["prices"]})


def resolve_baseline(root, baseline):
    """Historical commodities file: explicit path, else the retained evidence copy. Absolute paths are used as given."""
    path = baseline if baseline else BACKUP_DATASET
    return path if os.path.isabs(path) else os.path.join(root, path)


def compare_sources(root, staging_dir, backup_rel=None):
    backup_path = resolve_baseline(root, backup_rel)
    paths = {"production": os.path.join(root, PRODUCTION_DATASET), "backup": backup_path,
             "staged": os.path.join(staging_dir, ct.DATASET_FILE), "evidence": os.path.join(staging_dir, EVIDENCE_FILE),
             "sidecar": os.path.join(staging_dir, ct.SIDECAR_FILE)}
    for k, p in paths.items():
        if not os.path.exists(p):
            raise FileNotFoundError("%s not found: %s" % (k, p))
    P, B, S = load_dataset(paths["production"]), load_dataset(paths["backup"]), load_dataset(paths["staged"])
    with open(paths["evidence"], "rb") as fh:
        EV = ct.strict_loads(fh.read())
    with open(paths["sidecar"], "rb") as fh:
        SIDE = ct.strict_loads(fh.read())
    names = list(dict.fromkeys(list(P) + list(B) + list(S) + list(EV.get("symbols", {}))))
    rows = {}
    for n in names:
        p, _ = series_map(P.get(n))
        b, _ = series_map(B.get(n))
        s, _ = series_map(S.get(n))
        ev = EV.get("responses", {}).get(n)
        r, rskip = evidence_series(ev)
        inst = SIDE.get("instruments", {}).get(n, {})

        def cov(m):
            ks = sorted(m)
            return {"records": len(m), "first": ks[0] if ks else None, "last": ks[-1] if ks else None, **gap_summary(m)}
        rows[n] = {
            "symbol": EV.get("symbols", {}).get(n),
            "production": cov(p), "backup": cov(b), "provider_usable": cov(r), "staged": cov(s),
            "provider_response": ({k: ev.get(k) for k in ("kind", "rows", "price_field", "error", "counts")} if ev else None),
            "provider_skipped_in_comparison": rskip,
            "staged_status": inst.get("status"), "staged_reasons": inst.get("reasons"),
            "staged_attempt": inst.get("attempt"), "staged_revisions": inst.get("revisions"),
            "production_vs_backup": diff_profile(b, p), "provider_vs_production": diff_profile(p, r),
            "provider_vs_backup": diff_profile(b, r), "staged_vs_production": diff_profile(p, s),
            "steps_production_vs_backup": step_segments(b, p) if p and b else None,
            "steps_provider_vs_production": step_segments(p, r) if p and r else None,
        }
    return {"paths": paths, "instruments": rows,
            "request": EV.get("request"), "sidecar_outcome": SIDE.get("last_attempt")}


def render_markdown(report):
    L = ["# Stage 2C1 comparison tables (generated, read-only)", "",
         "P = production, B = historical baseline `%s`, R = provider usable observations, S = staged output." % report["paths"]["backup"],
         "Differences are exact; tolerance for 'representation-level' = %g; relative change = |new-old|/|old| (old != 0)." % TOLERANCE_REPR, "",
         "## Coverage", "",
         "| Instrument | P n (first..last) | B n (first..last) | R n (first..last) | S status |", "|---|---|---|---|---|"]
    f = lambda c: "%d (%s..%s)" % (c["records"], c["first"], c["last"])
    for n, r in report["instruments"].items():
        L.append("| %s | %s | %s | %s | %s |" % (n, f(r["production"]), f(r["backup"]), f(r["provider_usable"]), r["staged_status"]))
    for key, title in (("production_vs_backup", "P vs B (old=B, new=P)"), ("provider_vs_production", "R vs P (old=P, new=R)"),
                       ("provider_vs_backup", "R vs B (old=B, new=R)")):
        L += ["", "## " + title, "",
              "| Instrument | shared | added | removed | changed (exact) | <=tol | tol..<0.01 | >=0.01 | median abs | max abs | median rel | max rel |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for n, r in report["instruments"].items():
            d = r[key]
            b = list(d["buckets_abs_change"].values())
            g = lambda x: "-" if x is None else ("%.6g" % x)
            L.append("| %s | %d | %d | %d | %d | %d | %d | %d | %s | %s | %s | %s |" % (
                n, d["shared_dates"], d["added_dates"]["count"], d["removed_dates"]["count"], d["changed_exact"],
                b[0], b[1], b[2], g(d["abs_change"]["median"]), g(d["abs_change"]["max"]),
                g(d["rel_change"]["median"]), g(d["rel_change"]["max"])))
    L += ["", "## Calendar gaps (> 7 days between consecutive valid observations)", "",
          "| Instrument | P gaps / largest | B gaps / largest | R gaps / largest |", "|---|---|---|---|"]
    for n, r in report["instruments"].items():
        h = lambda c: "%d / %d" % (c["gaps_over_7d"], c["largest_gap_days"])
        L.append("| %s | %s | %s | %s |" % (n, h(r["production"]), h(r["backup"]), h(r["provider_usable"])))
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- collection --

class RecordingDownloader:
    """Wraps the real downloader and keeps what it returned and when."""

    def __init__(self, inner):
        self.inner, self.request, self.responses, self.error = inner, {}, None, None

    def __call__(self, symbols, start, end, **options):
        self.request = {"symbols": list(symbols), "start": start, "end": end, "options": dict(options),
                        "started_utc": datetime.now(timezone.utc).isoformat(), "provider_calls": 1, "retries": 0}
        try:
            self.responses = self.inner(symbols, start, end, **options)
        except BaseException as exc:
            self.error = "%s: %s" % (type(exc).__name__, exc)
            raise
        finally:
            self.request["finished_utc"] = datetime.now(timezone.utc).isoformat()
        return self.responses


def build_evidence(rec, symbol_map):
    ev = {"schema": "stage2c1_download_evidence_v1",
          "note": "Rows exactly as returned by the adapter. Invalid values are encoded as strings (NaN, Infinity, "
                  "-Infinity, bool:..., str:...) or null so this file is strict JSON. Rows with null/NaN prices are "
                  "mostly union-index rows of other symbols in the same batch download.",
          "request": rec.request, "batch_error": rec.error,
          "symbols": symbol_map, "responses": {}}
    resp = rec.responses if isinstance(rec.responses, Mapping) else {}
    for name, sym in symbol_map.items():
        r = resp.get(sym)
        if isinstance(r, Mapping) and "dates" in r and "prices" in r:
            counts = {"ok": 0, "null": 0, "nan": 0, "infinite": 0, "non_numeric": 0}
            valid_dates = []
            for d, p in zip(r["dates"], r["prices"]):
                k = ct.classify_price(p)[0]
                counts[k] += 1
                if k == "ok" and ct.parse_iso_date(d):
                    valid_dates.append(d)
            ev["responses"][name] = {"kind": "response", "price_field": r.get("price_field"), "rows": len(r["dates"]),
                                     "counts": counts, "first_valid": min(valid_dates) if valid_dates else None,
                                     "last_valid": max(valid_dates) if valid_dates else None,
                                     "dates": [d if isinstance(d, str) else encode_value(d) for d in r["dates"]],
                                     "prices": [encode_value(p) for p in r["prices"]]}
        elif isinstance(r, BaseException):
            ev["responses"][name] = {"kind": "error", "error": "%s: %s" % (type(r).__name__, r)}
        else:
            ev["responses"][name] = {"kind": "missing", "error": "no response for symbol %s" % sym}
    return ev


def collect(root):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    name = STAGING_PREFIX + stamp
    paths = resolve_staging(root, name)                       # raises if anything resolves to production
    if os.path.exists(paths["staging"]):
        raise FileExistsError(paths["staging"])
    os.makedirs(paths["staging"])
    prod = os.path.join(root, PRODUCTION_DATASET)
    with open(prod, "rb") as fh:
        prod_bytes = fh.read()
    shutil.copyfile(prod, paths["dataset"])
    with open(paths["dataset"], "rb") as fh:
        assert fh.read() == prod_bytes, "staged copy differs from production"
    lines = []

    def log(msg):
        lines.append(str(msg))
        print(msg)
    log("staging: %s" % paths["staging"])
    log("dataset destination: %s" % paths["dataset"])
    log("sidecar destination: %s" % paths["sidecar"])
    log("production dataset sha256 (unchanged expected): %s" % ct.sha256_hex(prod_bytes))
    recorder = RecordingDownloader(ct.yfinance_downloader)
    result = ct.run_refresh(recorder, output_dir=paths["staging"], log=log, download_options=dict(EXPERIMENT_OPTIONS))
    defaults = None
    try:
        import inspect
        import yfinance as yf
        defaults = {k: (None if v.default is inspect.Parameter.empty else repr(v.default))
                    for k, v in inspect.signature(yf.download).parameters.items()}
    except Exception as exc:
        defaults = {"error": repr(exc)}
    ev = build_evidence(recorder, ct.COMMODITY_MAP)
    ev["request"]["installed_yfinance_download_defaults"] = defaults
    ev["request"]["dependencies"] = ct.dependency_versions()
    ev["request"]["experiment_definition"] = ("auto_adjust=False and price field 'Close' set explicitly for THIS experiment; "
                                              "not evidence of how existing saved files were produced")
    ev_hash = write_json_strict(paths["evidence"], ev)
    verify = ct.main(["--verify", "--output-dir", paths["staging"]], log=log)
    summary = {"staging": paths["staging"], "exit_status": result["exit_status"], "outcome": result["outcome"],
               "dataset_replaced_in_staging": result["dataset_replaced"], "sidecar_written": result["sidecar_written"],
               "sidecar_error": result["sidecar_error"], "dataset_error": result["dataset_error"],
               "verify_exit": verify, "verify_status": ct.verify_consistency(paths["dataset"], paths["sidecar"]),
               "evidence_sha256": ev_hash, "counts": result.get("counts"),
               "statuses": {n: r["status"] for n, r in result["instruments"].items()}}
    write_json_strict(os.path.join(paths["staging"], "collect_summary.json"), summary)
    with open(os.path.join(paths["staging"], "collect_log.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    with open(prod, "rb") as fh:
        assert fh.read() == prod_bytes, "production dataset changed!"
    return summary


def compare(root, staging_name, baseline=None):
    """Read-only comparison; `baseline` is the historical commodities file (default: BACKUP_DATASET)."""
    paths = resolve_staging(root, staging_name)
    report = compare_sources(root, paths["staging"], baseline)
    write_json_strict(os.path.join(paths["staging"], REPORT_JSON), report)
    with open(os.path.join(paths["staging"], REPORT_MD), "w", encoding="utf-8") as fh:
        fh.write(render_markdown(report))
    return report


def main(argv=None):
    p = argparse.ArgumentParser(description="Stage 2C1 staged collection and read-only comparison.")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("collect", help="one bounded provider pass into a new staging directory")
    c = sub.add_parser("compare", help="read-only comparison; writes reports inside staging only")
    c.add_argument("--staging", required=True, help="staging directory name (staging_stage2c1_*)")
    c.add_argument("--baseline", default=None,
                   help="historical commodities_data.json to compare against (path relative to the project root, or "
                        "absolute); default: %s" % BACKUP_DATASET.replace("\\", "/"))
    args = p.parse_args(argv)
    root = os.getcwd()
    if args.cmd == "collect":
        s = collect(root)
        print(json.dumps({k: s[k] for k in ("staging", "exit_status", "outcome", "verify_status", "statuses")}, indent=1))
        return 0
    compare(root, args.staging, args.baseline)
    print("comparison written inside", args.staging)
    return 0


if __name__ == "__main__":
    sys.exit(main())
