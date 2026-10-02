# PROJECT_CONTEXT.md — Kutun Terminal

*Maintained by: development session. Update the CURRENT STATE section at the start of each Stage.*

---

## Purpose

Kutun Terminal is a local, browser-based financial dashboard for equity and macro research. It displays static market snapshots collected by Python scripts and does not communicate with any exchange in real time.

---

## CURRENT STATE (authoritative — read this first; updated Stage 2E)

**Current stage:** Stage 2E (frontend data loading and chart inspection integrity) is complete in code and JavaScript tests (42/0, 969/0). User close-out did not report pass/fail for the listed Chrome checks; those remain **NOT VERIFIED**. Hard-reload `app.js` before judging the UI.

**Working folder:** `C:\Users\yigit\OneDrive\Desktop\Kutun-Terminal-main\Kutun-Terminal-main` (the ZIP nests two `Kutun-Terminal-main` folders; the inner one holds `index.html` and `app.js`).

**Recovery:** `C:\Users\yigit\OneDrive\Desktop\Kutun-Terminal-main\Kutun-Terminal-main_recovery_20261002_161057.zip` (156 entries; no `.git`, no caches). Verified: every file later removed from the active tree matched the ZIP by SHA-256 (115/115). Full pre-cleanup documentation and staging reports are in that ZIP (internal prefix `Kutun-Terminal-main/`) and, for tracked source, in Git commit `7f9b987`.

**Git:** local repository at the project root, branch `main`, no remotes. Use commits for source checkpoints. Do not push unless separately asked.

**Data state:**
- Commodities: 13 series end 2026-09-30 (promoted Stage 2C2, SHA-256 `5C255BB2...2DA3`); sidecar `commodities_data_meta.json` (`1DE04958...3FFB`). Lumber is still a single 2023-04-10 record (380.6). Gold backup-vs-production revisions (1,389 dates 2020-05-29..2026-03-13) are unresolved. Canonical historical file: `evidence/commodities_data_pre_refresh_20260916.json` (SHA-256 `D1BEDA34...62EB`; source `_pre_refresh_20260916_214324`).
- Sectors: production `sector_historical.json` replaced in Stage 2D3 (SHA-256 `EEA98904...3345`; sidecar `8C64BFA1...36CB`, `py sector_tracker.py --output-dir . --verify` = consistent). 11 ETFs; nine run 2005-01-03 to 2026-10-01; XLRE from 2015-10-08; XLC from 2018-06-19. Values are provider `Close` (`auto_adjust=False`): **price returns that exclude distributions**, not total returns. The 2026-10-01 observation is provider-reported; session completeness and provider corporate-action treatment are unverified. Events before an ETF's listing no longer show invented XLRE/XLC returns.
- Equities, news and events: unchanged since earlier stages. News is stale (latest pub 2026-03-15).
- Runtime JSON is fetched with `cache: 'no-store'` (Stage 2E). Serving/reloading still does not run collectors. A browser that has cached **`app.js`** can still show old frontend behaviour until a hard reload.

**How to start:** double-click `start-terminal.cmd`, or from the project root run `py -m http.server 8000 --bind 127.0.0.1` and open `http://127.0.0.1:8000`. Stop with Ctrl+C. Serving does **not** refresh data.

**Refresh commands — what is safe:**
- Commodities: `py commodity_tracker.py` (Stage 2B safety rules; reuse a staging `--output-dir` for reviews).
- Sectors: `py sector_tracker.py --output-dir <existing staging directory>` (required; refuses the application folder unless `--allow-app-directory`). Real provider requests need an approved plan. Promotion is a separate, backed-up step.
- **Do NOT use `py macro_engine.py` as a sector-only or routine refresh.** It also rewrites `macro_events.json` and `live_news.json`, back-fills sector prices, swallows errors and reports completion regardless.
- `py equity_engine.py`, `py finance_tracker.py`: unchanged; neither has been reviewed for failure safety in this stage.

**Tests (from the project root):** see README.md. The sector legacy-fill regression uses `tests/fixtures/legacy_sector_fill_shape.json` and does not need an `archive/` folder.

**Current roadmap:**

| Step | Status |
|------|--------|
| Chart/event/snapshot integrity (D1–D8), 2A diagnosis, 2B–2C commodities, 2D sectors, Git/cleanup | Done |
| Frontend fetch cache, date-associated tooltips, single-observation disclosure | **Stage 2E (this checkpoint)** — JS tests only; live browser **NOT VERIFIED** |
| Event-offset / event-methodology repair | Next remaining product work |
| First domino-thesis pilot | After event-offset |
| Open data items: Lumber history, Gold backup revisions, stale news, equity/news/event collector safety | Not scheduled |
| Later product work (energy deep-dive, news, map, journal, paper portfolio) | Not started; see Product Direction |

---

## Product Direction (context only — updated 2026-09-30)

Kutun Terminal is evolving into a **geopolitical policy and investment-scenario research workspace** for horizons of roughly one week to one year. Planned core workflow:

policy question → evidence and competing scenarios → first-, second- and third-order industry effects → market expectations → candidate exposures → timestamped paper deployment decisions → outcome review.

Deferred: full DCF/comps portal, world map, automated trading, leverage optimisation.

### Current features (implemented)
- Static-snapshot dashboard: commodities, sector ETFs, equities, news, macro-event archive, data-status panel.
- Historical event mode shared by the main terminal and the FX & Commodities tab: event selector, event horizons (1W/1M/3M/6M/Event-year end/1Y/5Y/MAX, observation-based), validated chronological series views, 7-day baseline-age limit, pre-event baseline, multi-series date alignment, event audit table (T+1/T+5/T+22/T+252), Latest Snapshot reset.
- Sector panel disclosure: "Sector ETF price returns use provider Close and exclude distributions. Data before each ETF's available history is unavailable." Event mode names ETFs with no history before the event.

### Planned (NOT implemented — do not assume these exist)
- Policy-question intake, evidence log, competing-scenario modelling.
- First/second/third-order industry-effect mapping and market-expectation comparison.
- Candidate-exposure shortlist and timestamped paper deployment decisions.
- Outcome review of past decisions.

### Event-window conventions (settled in code and tests)
Archive events are **date-only** (no intraday times). Returns are provisional until a methodology decision is made.
- **Series integrity:** each series becomes a validated chronological view (dates and prices paired before sorting, source arrays untouched). Unequal lengths, invalid calendar dates and duplicate dates make that series unavailable; other series still render. Invalid prices stay as dated gaps.
- **Baseline:** latest **finite** price strictly before the event date, searching past null/undefined/non-finite records, at most `MAX_EVENT_BASELINE_AGE_DAYS = 7` calendar days old. Shared implementation: `buildEventSeriesView` / `selectEventBaseline`.
- **Percentage returns** need a strictly positive baseline. Zero/negative finite baselines are selected as-is (no further search).
- **Horizons** 1W/1M/3M/6M/1Y/5Y are observation counts (5/22/63/126/252/1260) from the baseline, not verified calendar periods.
- **YTD in event mode = "Event-year end"** (Dec 31 of the event year). Snapshot-mode YTD is unchanged.
- **KNOWN EVENT-OFFSET ISSUE (unrepaired):** invalid pre-event records between a searched-back baseline and the event may count toward forward offsets. Currently latent because no invalid prices are saved.

### Latest Snapshot conventions (settled in code and tests)
- **One formula:** `isValidPrice` / `computePriceReturn`. Null, undefined, NaN, +/-Infinity and numeric strings are never coerced.
- **Sector/commodity trailing returns:** 1D/1W/1M/1Y = 1/5/22/252 observations before the latest observation.
- **Validation before slicing:** `buildEventSeriesView`, same helper as event mode. Sources are never mutated; nothing is filled.
- **Calendar-gap screen:** consecutive source observations more than 7 calendar days apart are reported. Not an exchange-session audit.
- **Rolling windows** are anchored to today's UTC calendar date. MAX floor is 2005-01-01. A window with no observations does not widen to full history.
- **Mixed-date tooltip: UNVERIFIED / unrepaired.** Hypothesis: Chart.js 4.4.0 `interaction.mode:'index'` applies one data-array index to datasets of different lengths. Manual steps were in `DATA_COVERAGE_AUDIT.md` section 2c (recovery ZIP: `Kutun-Terminal-main/DATA_COVERAGE_AUDIT.md`).

---

## Future workflow

- **Source checkpoints:** Git commits on `main`. Do not create a timestamped `archive/pre_*` folder for ordinary edits.
- **Live-data experiments:** one staging directory per experiment (`staging_<purpose>_<UTC stamp>`), then after review retain only necessary evidence (for example one historical baseline file). Do not keep the whole staging tree in the active project.
- **Dataset replacements:** back up the production dataset (and sidecar if present) when a material replacement needs rollback. Git is not a substitute for a verified copy of a large JSON snapshot you are about to overwrite, unless that snapshot is already committed and you are sure you want the previous commit's bytes.
- **New scripts:** add a script only when it has a reusable purpose. One-off promotion/review drivers belong in the staging directory of that experiment, not in the project root.
- **Status:** record ordinary checkpoint outcomes in `STAGE1B_STATUS.md`. Do not add a new standalone report for routine work.
- **Do not** add broad folder exclusions that hide maintained source, fixtures or necessary evidence. `.gitignore` is only for caches and transient leftovers. Ignoring a path does not untrack files already in Git.

---

## Local Operating Setup

### Folder
Project root (contains `index.html`, `app.js`, `tests/`):
```
C:\Users\yigit\OneDrive\Desktop\Kutun-Terminal-main\Kutun-Terminal-main\
```

### Starting / stopping
Double-click `start-terminal.cmd` (Python 3.x; serves `http://127.0.0.1:8000`). Stop with Ctrl+C. Serving does not run collectors.

### Browser refresh
F5 / Ctrl+R reloads saved JSON from disk. It does not fetch market data. If a dataset changed on disk and the page still shows old numbers, hard-reload (Ctrl+F5).

### Comparison commands (read-only)
```
py stage2c_review.py compare --staging staging_stage2c1_YYYYMMDD_HHMMSS [--baseline PATH]
py sector_candidate_compare.py --production sector_historical.json --candidate <candidate.json> --out-json <out.json>
node sector_event_coverage.js --events macro_events.json --dataset production=sector_historical.json --dataset candidate=<candidate.json> --out <dir>
py coverage_audit.py --as-of YYYY-MM-DD
py commodity_tracker.py --verify
py sector_tracker.py --output-dir . --verify
```
`--baseline` defaults to `evidence/commodities_data_pre_refresh_20260916.json`. `collect` on `stage2c_review.py` makes a real provider request; do not run it without an approved plan.

### Running tests
See README.md. Requires Node.js 18+ and Python 3. `tests/test_event_analysis.js` executes the real `app.js` in a `node:vm` context; mocks are not visual browser verification. `tests/test_stage1b_suite.py` re-implements event logic in Python and is not verification of production JavaScript. `tests/check_js_syntax.py` is a bracket-balance heuristic, not a syntax check.

---

## Historical evidence (not in the active tree)

Full stage transcripts, staging reports and timestamped source backups were removed from the working copy after this cleanup. Recover them from:

1. Recovery ZIP `Kutun-Terminal-main_recovery_20261002_161057.zip` (prefix `Kutun-Terminal-main/`). Includes `archive/`, both `_pre_refresh_*` folders, `_backup/`, `staging_stage2c1_20261001_025814/`, `staging_stage2d2_20261002_023649/`, `DATA_COVERAGE_AUDIT.md`, `EVENT_DATE_AUDIT.md`, and the pre-cleanup `PROJECT_CONTEXT.md` / `STAGE1B_STATUS.md`.
2. Git commit `7f9b987` for tracked source, tests, runtime datasets and the pre-cleanup documentation.

Material decisions from those stages are summarised in CURRENT STATE above. Do not treat the condensed text as a substitute for the promotion records when rolling back a dataset.
