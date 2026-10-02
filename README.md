https://github.com/YKutun/Kutun-Terminal

# KUTUN TERMINAL | Geopolitical Macro & Equity Intelligence Terminal

A local financial intelligence dashboard displaying static market snapshots for macro and equity research.
Data is collected by Python scripts and served as a local web application — nothing is streamed from an exchange in real time.

> **Current stage: 2D3 complete**, plus local Git and cleanup (see PROJECT_CONTEXT.md).
> **Production sector history** is the reviewed provider `Close` series (ends 2026-10-01, provider-reported; XLRE/XLC begin at their listing dates). Sector returns are **price returns that exclude distributions**, not total returns. The pre-promotion file is in the recovery ZIP, not in an `archive/` folder.
> See the "CURRENT STATE" section of [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) for the roadmap and known limitations; the Stage 1A material in that file is historical.

---

## Quick Start

1. Make sure **Python 3.x** is installed. Check by opening a terminal and running `py --version`.
2. Double-click **`start-terminal.cmd`** in the project folder.
3. The script opens `http://127.0.0.1:8000` in your browser automatically.
4. To stop: press **Ctrl+C** in the CMD window.

If you see a blank page, wait a second and press **F5** to reload.

---

## Manual Launch (if the script doesn't work)

Open a terminal, navigate to this folder, and run:

```
py -m http.server 8000 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8000` in your browser.

---

## Browser Refresh

Pressing **F5 / Ctrl+R** reloads the saved JSON and CSV files from disk.

It does **NOT** fetch new market data, and neither does starting the server — serving never refreshes data. To update data, run the Python collectors deliberately (see below). If a dataset changed on disk and the page still shows old numbers, hard-reload (**Ctrl+F5**), because the browser may cache the JSON.

---

## Updating Market Data

The dashboard reads from static snapshot files. To refresh them, open a terminal in this folder and run the relevant collector:

| What to update | Command |
|---|---|
| Commodity prices | `py commodity_tracker.py` (failure-safe; writes `commodities_data_meta.json`) |
| Sector ETF history | `py sector_tracker.py --output-dir <existing staging folder>` — sector-only, stages a candidate; makes real provider requests, so run it only as part of an approved, reviewed plan |
| Equity prices + fundamentals | `py equity_engine.py` |

**Do not use `py macro_engine.py` to refresh sectors (or as a routine refresh).** Besides sector history it always rewrites the curated event archive (`macro_events.json`) and the news feed, back-fills missing sector prices, and reports completion even when requests fail. It is kept only as a historical script until it is separately reviewed.

`sector_tracker.py` never writes anywhere but the folder you name, refuses a missing folder and refuses the application folder (the one containing `index.html`), never fills missing prices, and keeps previous data when a refresh fails. Copying its output over `sector_historical.json` is a separate, reviewed step, not part of the command.

**Wait for the script to finish before refreshing the browser.** Do not run collectors while reviewing the dashboard.

`finance_tracker.py` downloads adjusted-close prices and AAPL fundamentals to CSV files; it does not update the dashboard JSON files.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| "Port 8000 is already in use" | The server may already be running — try visiting `http://127.0.0.1:8000`. If needed, close the existing CMD window and run `start-terminal.cmd` again. |
| "Python launcher not found" | Install Python 3 from [python.org](https://www.python.org/downloads/) — tick "Add Python to PATH". |
| Dashboard shows "FAILED" for a dataset | The JSON file may be missing or malformed. Run the relevant collector above. Other tabs are not affected. |
| Charts show "No data in this period" | The selected timeframe is more recent than the snapshot. Try **MAX** or **5Y**, or update the data. |
| Blank or old news feed | The snapshot was collected on a specific date and is not auto-refreshed. A news-only refresh command has not been built; `py macro_engine.py` would also overwrite the event archive and sector history, so do not run it casually (see PROJECT_CONTEXT.md). |

---

## Data Status Panel

A compact panel below the navigation bar shows the loaded/empty/failed status of each dataset,
the latest observation date derived from the actual data, and a staleness flag (>30 calendar days).

This flag is a simple age warning, **not** an exchange-calendar freshness check.
Data in the "loaded" state is a snapshot; it is not "current" or "suitable for trading decisions."

---

## Running Tests

From the project root:

```
node --check app.js
node --check tests/test_event_analysis.js
node tests/test_data_status.js
node tests/test_event_analysis.js
py tests/test_sector_tracker.py
py tests/test_sector_candidate_compare.py
py tests/test_commodity_tracker.py
py tests/test_coverage_audit.py
py tests/test_stage2c_review.py
py commodity_tracker.py --verify
py sector_tracker.py --output-dir . --verify
```

Requirements: Node.js 18+ and Python 3. The Python tests use fake downloaders (no network, no writes to project data); two sector adapter tests need `pandas` (already required by the collectors). The sector legacy-fill regression uses `tests/fixtures/legacy_sector_fill_shape.json` and runs without an `archive/` folder. Promoted-production checks skip only if the live sector dataset or sidecar is absent.

### Comparison (read-only)

```
py stage2c_review.py compare --staging <staging_stage2c1_...> [--baseline evidence/commodities_data_pre_refresh_20260916.json]
py sector_candidate_compare.py --production sector_historical.json --candidate <candidate.json> --out-json <out.json>
py coverage_audit.py --as-of YYYY-MM-DD
```

`--baseline` may be omitted; the evidence path above is the default. Do not run `stage2c_review.py collect` or `sector_tracker.py` without `--verify` against production unless a reviewed plan authorizes a provider request.

---

## Screenshots

### Main Intelligence Hub

The Main Intelligence Hub provides a unified view of macro news, sector price returns, and commodity barometers.
<img width="1918" height="1023" alt="image" src="https://github.com/user-attachments/assets/b3812aa1-c3f8-4183-9d55-714507651e77" />

### Historical Impact Engine

When a user selects a macro event (e.g., the 2011 US Credit Downgrade), the terminal snaps all cross-asset charts to that timeframe and shows retrospective price returns for sectors and commodities at T+1D, T+1W, and T+1M. These figures are retrospective observations, not validated predictive backtests.
<img width="1918" height="1024" alt="image" src="https://github.com/user-attachments/assets/175dcf20-05d4-47cd-8bc9-ea5b0648a772" />

### Integrated Equity Terminal (US & TSX)

A custom Equity Terminal backed by a Python data pipeline, covering US (S&P 100) and Canadian (TSX) tickers.
<img width="1919" height="1025" alt="image" src="https://github.com/user-attachments/assets/8bbd23ff-1360-4f54-b0f2-aa193e0f6636" />

### FX & Commodities Cross-Correlator

Overlays commodity price returns for a selected historical event window or as a standalone comparison tool.
Returns shown are price returns from the start of the selected window; they are not total returns (dividend adjustment not verified).
<img width="1919" height="1027" alt="image" src="https://github.com/user-attachments/assets/4b694044-634f-40b4-b282-409b5f09ebc4" />
