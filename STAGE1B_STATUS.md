# Current Status and Backlog

**Last updated:** 2026-10-02 (Stage 2E)
**Working folder:** `C:\Users\yigit\OneDrive\Desktop\Kutun-Terminal-main\Kutun-Terminal-main`
**Git:** local repo, branch `main` (Stage 2E committed; `stage2c_review.py` comment may remain unstaged)
**Recovery ZIP:** `C:\Users\yigit\OneDrive\Desktop\Kutun-Terminal-main\Kutun-Terminal-main_recovery_20261002_161057.zip`

Stage 1B chart/event/snapshot integrity work is delivered. This file is the concise status/backlog, not a full transcript. Pre-cleanup history: recovery ZIP (`Kutun-Terminal-main/STAGE1B_STATUS.md`, `PROJECT_CONTEXT.md`, `DATA_COVERAGE_AUDIT.md`, `EVENT_DATE_AUDIT.md`) and Git `7f9b987`.

---

## Current production hashes (SHA-256)

| File | SHA-256 | Notes |
|------|---------|-------|
| `sector_historical.json` | `EEA9890432BC8EA3547F824378EA3E3B722DFE59DFE28270C14CAA3E505A3345` | Stage 2D3; provider Close to 2026-10-01 |
| `sector_historical_meta.json` | `8C64BFA16FC03B00A9CE4D38F8A2AF5C6E7AFF8EAD5325CA88033C3E896436CB` | timeout correction recorded |
| `commodities_data.json` | `5C255BB2F469A9C91C2F79DB8FCCFC3C2AE1FECE9DE0697CD0D26AA18C602DA3` | Stage 2C2; Lumber still 1 record |
| `commodities_data_meta.json` | `1DE04958BDB8E5F47D2D08E04D9C53A17CA5CED22880C4AA8C7948ACB4283FFB` | |
| `equity_data.json` | `58D7C3479E627238AFDD343917D4116016E709FD03ACC1D6387507BF36B41319` | |
| `equity_data_meta.json` | `DDB6EADB4E62D361E71B015ADFB0895F707907EAC5696645545DD655C8760104` | |
| `macro_events.json` | `3FE05932ADDF387DB1241497C472066B384968EFDBD340FEAE39B12888B95CC1` | curated; 12 events |
| `live_news.json` | `11170E8477084E6E48E943F5F67051E80C0297B0908D2C09A1FE36AC4BB65826` | stale |
| `app.js` | `49200A7F7CC867FA88A687317611B8088FA335DCBFD66E3DF62C01F2B99010EE` | Stage 2E frontend |
| `index.html` | `D408FE137280237F213C9FD42CB957E3B050A5FB25D335486FEA06A6FA799E33` | unchanged |

Canonical historical commodity file: `evidence/commodities_data_pre_refresh_20260916.json` = `D1BEDA347ECA8F0D6292DA61E951CE6957892EA61A53574B60D89ACF89B662EB`.

---

## Backlog (next work)

1. Event-offset / event-methodology repair (invalid pre-event records between a searched-back baseline and the event may count toward forward offsets).
2. First domino-thesis pilot.
3. Unscheduled data: Lumber history vs `LBS`/`LBR`, Gold backup revisions, stale news, equity/news/event collector safety.
4. Live Chrome confirmation of Stage 2E (listed below). **NOT VERIFIED** — close-out named the checks but did not report pass, fail, or skip for any of them.

---

## Stage 2E (2026-10-02)

Frontend only. Datasets/sidecars/`index.html` hashes unchanged vs the pre-task baseline recorded in the prior session.

- `fetchDataset` uses `{ cache: 'no-store' }`. HTTP/parse/network error shapes unchanged. 304 is not treated as a successful body. Collectors are not invoked by serve/reload.
- Snapshot (and event) master charts no longer use Chart.js `index` interaction. Tooltip items are matched by each point’s observation date (`tooltipItemsAtDate` / `tooltipFilterSameDate`). Mixed-date pairing by array index was reproduced in tests and rejected.
- A percentage window with one usable observation returns `Single observation [date]; return unavailable.` (not a plotted 0.00% marker). Other selected series still render.

**Tests:** `node --check app.js` and `node --check tests/test_event_analysis.js` exit 0. `node tests/test_data_status.js` 42/0. `node tests/test_event_analysis.js` 969/0. Reused at close-out: `app.js` and the two test files were unchanged since those runs. Suites are mock/callback tests, not visual hover.

**Browser (user Chrome close-out; no pass/fail reported, so none recorded as passed):**

| Check | Result |
|-------|--------|
| Gold / WTI / Lumber at 5Y and MAX | **NOT VERIFIED** |
| Lumber-only explanation and recovery | **NOT VERIFIED** |
| Tooltip dates | **NOT VERIFIED** |
| Fukushima horizons | **NOT VERIFIED** |
| Return to Latest Snapshot | **NOT VERIFIED** |

No failure was reported. Agent browser automation earlier was interrupted and saw a cached pre-2E `app.js`; that is not user verification.

---

## Post-Stage-2D3 Git and cleanup (2026-10-02)

**Recovery ZIP verified before any deletion.** 156 entries, no `.git`, no `__pycache__`. 115 files proposed for removal matched the ZIP byte-for-byte. The two `_pre_refresh_*` folders were identical (5 files each).

**Git:** a suitable repository already existed at the project root (not inside a parent repo). History preserved. Baseline commit `7f9b987` already contained intended source, tests, runtime datasets, sidecars and docs; archive/staging folders were intentionally untracked. Identity: existing global `Yigit Kutun <yigkutun@gmail.com>` (no config changes). No remotes, no push.

**Code/test repairs:**
- Sector legacy regression no longer searches `archive/pre_stage2d3_*`. It loads `tests/fixtures/legacy_sector_fill_shape.json` (11 ETFs; XLRE/XLC have a 10-observation identical leading run). Assertions kept: usable prior, unchanged bytes on failed refresh, `possible fill` on XLRE and XLC only, `retained_legacy_unverified` provenance. The test **fails** if the fixture is missing (no skip).
- `stage2c_review.py compare --staging NAME [--baseline PATH]`. Default baseline is the evidence file above, not `_pre_refresh_20260916_214324`. Absolute paths accepted.

**Removed from the active tree** (all recoverable from the ZIP at the same relative paths under `Kutun-Terminal-main/`):

| Path | Approx. bytes | Why |
|------|----------------|-----|
| `archive/` (15 timestamped source-backup folders) | 9,921,162 | Replaced by Git + ZIP |
| `_backup/` | 253,363 | Stage 1A copies |
| `_pre_refresh_20260916_214324/` | 7,350,354 | Duplicate of 214406; commodity file retained in `evidence/` |
| `_pre_refresh_20260916_214406/` | 7,350,354 | Identical to 214324 |
| `staging_stage2c1_20261001_025814/` | 5,321,824 | Completed commodity staging; reports in ZIP |
| `staging_stage2d2_20261002_023649/` | 11,347,441 | Completed sector staging; reports in ZIP |
| `__pycache__/` | 159,050 | Regenerable |
| `DATA_COVERAGE_AUDIT.md`, `EVENT_DATE_AUDIT.md` | (tracked; git rm) | Historical reports; originals in ZIP and `7f9b987` |

Approximate space recovered: **~40 MiB** uncompressed (ZIP on disk is 7,265,599 bytes).

**Kept:** runtime code, production datasets and sidecars, maintained tests, reusable tools (`coverage_audit.py`, `sector_candidate_compare.py`, `sector_event_coverage.js`, `stage2c_review.py`, collectors), `evidence/` (canonical commodity baseline + two Stage 1A checksum files), `tests/fixtures/legacy_sector_fill_shape.json`.

**Future rules:** Git commits for source checkpoints; no routine per-edit archive folders; one staging directory per live-data experiment, then keep only necessary evidence; back up datasets when a material replacement needs rollback; add a script only when it has a reusable purpose; record ordinary outcomes here; do not hide maintained source with broad ignore rules.

---

## Earlier stages (pointer only)

Delivered, in order: Stage 1A operational reliability; 1B event/snapshot integrity (D1–D8, event-window, snapshot calculation, snapshot dates/gaps); 2A coverage diagnosis; 2B commodity collector safety; 2C1 staged commodity download; 2C2 commodity promotion (Lumber unchanged); 2D1 sector collector; 2D2 staged sector download; 2D3 sector promotion (D1 Close / D2 drop pre-listing fills). Full transcripts and promotion records are in the recovery ZIP.
