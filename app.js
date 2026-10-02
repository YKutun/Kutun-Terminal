// ============================================================
// app.js — Kutun Terminal | Stage 1B: Data Recovery & Event Windows
// ============================================================
//
// Data model: all JSON files are static snapshots collected by
// Python scripts (macro_engine.py for news/sectors/events;
// equity_engine.py for equities; commodity_tracker.py for
// commodities).  Nothing here is a live feed.  Browser refresh
// reloads the saved files; it does NOT fetch new market data.
//
// Chart modes
// -----------
// LATEST SNAPSHOT MODE (activeEventMode = false):
//   The master chart and barometer use rolling calendar-based
//   timeframe windows (1W, 1M, 3M, 6M, YTD, 1Y, 5Y, MAX), anchored to
//   today's UTC date (not to each series' latest observation); see the
//   "Snapshot window policy" comment above sliceByTimeframe().
//   Series are validated (paired/sorted, duplicate/invalid dates and unequal
//   lengths rejected) before slicing; each instrument is aligned by its own
//   actual dates and normalised to its own first finite, positive price.
//   activeMasterTimeframe drives sliceByTimeframe().
//   activeCustomRange must be null in this mode.
//
// HISTORICAL EVENT MODE (activeEventMode = true):
//   A historical macro event has been selected.
//   The timeframe buttons control post-event trading-observation
//   horizons rather than calendar windows.
//   Baseline = latest finite price strictly before the date-only event
//   date, searched past invalid records, at most 7 calendar days old
//   (provisional — intraday timestamps are not available in the
//   current archive; this convention is disclosed in the UI).
//   activeEventHorizon holds the chosen horizon label.
//   Clicking "Latest Snapshot" explicitly exits this mode.
//
// Horizon trading-observation definitions (provisional):
//   1W  =   5 obs    3M  =  63 obs    1Y  = 252 obs
//   1M  =  22 obs    6M  = 126 obs    5Y  = 1260 obs
//   MAX = all observations after baseline
//   YTD (labelled "Event-year end") = baseline through Dec 31 of the event
//   year; coverage is reported as covered / unverified / incomplete.
//
// ── Configurable constants ───────────────────────────────────
//
// STALE_DAYS: number of calendar days after which a dataset is
// flagged as potentially stale.  This is a simple age warning,
// NOT an exchange-calendar freshness check.  It does not account
// for weekends, holidays, or expected publication lag.  Do not
// interpret "within threshold" as "current" or "suitable for
// trading decisions".
const STALE_DAYS = 30;

// Trading-observation counts for each event horizon.
// "MAX" and "YTD" are handled procedurally; they are not listed here.
const EVENT_HORIZON_OBS = {
    '1W':  5,
    '1M':  22,
    '3M':  63,
    '6M':  126,
    '1Y':  252,
    '5Y':  1260,
};

// ── Shared price validation (D1) ─────────────────────────────
// A usable price is a JavaScript number that is finite. null, undefined,
// NaN, +/-Infinity and numeric strings are all rejected WITHOUT coercion,
// so they can never turn into 0, -100%, Infinity% or a chart point.
// Finite negative raw prices ARE valid prices (they can be displayed and can
// be an endpoint); only percentage returns need a strictly positive baseline.
function isValidPrice(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

// Price return in percent: (endpoint / baseline - 1) * 100.
// Returns { ok: true, pct } or { ok: false, reason } and never a non-finite pct.
// The baseline must be strictly positive; zero/negative baselines make a
// percentage meaningless, and no earlier price is substituted. A finite
// negative ENDPOINT with a positive baseline is a valid arithmetic change.
function computePriceReturn(basePrice, endPrice) {
    if (!isValidPrice(basePrice)) return { ok: false, reason: 'baseline price missing or invalid' };
    if (basePrice === 0) return { ok: false, reason: 'baseline price is zero' };
    if (basePrice < 0) return { ok: false, reason: 'baseline price is negative (percentage return needs a positive baseline)' };
    if (!isValidPrice(endPrice)) return { ok: false, reason: 'price missing or invalid' };
    const pct = (endPrice - basePrice) / basePrice * 100;
    if (!Number.isFinite(pct)) return { ok: false, reason: 'return not finite' };
    return { ok: true, pct };
}

function fmtUsd(v) {
    return v < 0 ? `-$${Math.abs(v).toFixed(2)}` : `$${v.toFixed(2)}`;
}

// ── Event-window integrity (D5/D6/D7) ────────────────────────
// PROVISIONAL, configurable quality thresholds. They are calendar-day
// distance checks only; they do NOT verify exchange sessions or calendars.
//
// MAX_EVENT_BASELINE_AGE_DAYS: the selected pre-event baseline may be at most
// this many calendar days before the (date-only) archive event date. Exactly
// this many days is allowed; more is unavailable.
const MAX_EVENT_BASELINE_AGE_DAYS = 7;
// EVENT_YEAR_END_TOLERANCE_DAYS: for the event-year-end horizon, a series whose
// last record is within this many days before December 31 has UNVERIFIED
// year-end coverage (no calendar to prove it is the final session), and the
// year-end endpoint may be at most this many days before the boundary.
const EVENT_YEAR_END_TOLERANCE_DAYS = 7;

// Strict YYYY-MM-DD -> whole days since 1970-01-01 (UTC), or null when the
// string is not an actual calendar date. Timezone-independent.
function parseIsoDateToDay(s) {
    if (typeof s !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const t = Date.UTC(y, mo - 1, d);
    const dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return Math.round(t / 86400000);
}

// Build a validated chronological view of one series WITHOUT mutating the
// source arrays. Dates and prices are paired before sorting, so they can never
// drift apart. Invalid prices stay in the view as null gaps (they keep their
// date and keep counting toward observation offsets).
// Unavailable (ok:false) when: labels/prices are not arrays, lengths differ,
// any date is not a real calendar date, or a date occurs twice (ambiguous).
function buildEventSeriesView(labels, prices) {
    if (!Array.isArray(labels) || !Array.isArray(prices)) {
        return { ok: false, reason: 'labels or prices missing' };
    }
    if (labels.length !== prices.length) {
        return { ok: false, reason: `labels (${labels.length}) and prices (${prices.length}) have different lengths` };
    }
    const seen = new Set();
    const recs = [];
    for (let i = 0; i < labels.length; i++) {
        const day = parseIsoDateToDay(labels[i]);
        if (day === null) return { ok: false, reason: `invalid calendar date at position ${i}: ${String(labels[i])}` };
        if (seen.has(labels[i])) return { ok: false, reason: `duplicate date ${labels[i]} (ambiguous prices)` };
        seen.add(labels[i]);
        recs.push({ d: labels[i], day, p: isValidPrice(prices[i]) ? prices[i] : null });
    }
    recs.sort((a, b) => a.day - b.day);
    return {
        ok: true,
        labels: recs.map(r => r.d),
        days: recs.map(r => r.day),
        prices: recs.map(r => r.p),
        length: recs.length
    };
}

// The single baseline policy used by event charts, the impact panel/audit
// table and the sector/commodity event backtest:
//   latest FINITE price strictly before the event date, searching past
//   null/undefined/non-finite records, at most MAX_EVENT_BASELINE_AGE_DAYS
//   calendar days before the event. A zero/negative finite baseline is still
//   "selected" (raw prices stay displayable) and is never searched past;
//   percentage returns are made unavailable by the consumers instead.
function selectEventBaseline(view, eventDateStr) {
    const eventDay = parseIsoDateToDay(eventDateStr);
    if (eventDay === null) {
        return { ok: false, code: 'bad-event-date', reason: `Invalid event date: ${String(eventDateStr)}`, short: 'invalid event date', incompleteReason: 'Invalid event date' };
    }
    let lastBefore = -1;
    for (let i = 0; i < view.length; i++) {
        if (view.days[i] < eventDay) lastBefore = i; else break;
    }
    if (lastBefore === -1) {
        return {
            ok: false, code: 'no-pre-event',
            reason: `No pre-event baseline observation available strictly before ${eventDateStr} (series may begin after event)`,
            short: 'no pre-event observation', incompleteReason: 'Baseline unavailable'
        };
    }
    let idx = -1;
    for (let i = lastBefore; i >= 0; i--) {
        if (view.prices[i] !== null) { idx = i; break; }
    }
    if (idx === -1) {
        return {
            ok: false, code: 'no-valid-price',
            reason: `No valid price on or before ${view.labels[lastBefore]}: all ${lastBefore + 1} pre-event observation(s) are invalid or missing`,
            short: 'no valid pre-event price', incompleteReason: 'Baseline price invalid'
        };
    }
    const ageDays = eventDay - view.days[idx];
    const sel = {
        idx, date: view.labels[idx], price: view.prices[idx], ageDays,
        skipped: lastBefore - idx
    };
    if (ageDays > MAX_EVENT_BASELINE_AGE_DAYS) {
        return {
            ok: false, code: 'too-old', candidateDate: sel.date, candidateAgeDays: ageDays, skipped: sel.skipped,
            reason: `Latest usable pre-event price is ${sel.date}, ${ageDays} days before the event (limit ${MAX_EVENT_BASELINE_AGE_DAYS} calendar days)`,
            short: `baseline too old: latest usable price ${sel.date} is ${ageDays} days before event (limit ${MAX_EVENT_BASELINE_AGE_DAYS})`,
            incompleteReason: 'Baseline too old'
        };
    }
    return Object.assign({ ok: true }, sel);
}

// Label for a horizon in event mode. YTD means the boundary is December 31 of
// the EVENT year, not the current year.
function eventHorizonLabel(h) {
    return h === 'YTD' ? 'Event-year end' : h;
}
// ── Global state ─────────────────────────────────────────────
let commodityData = {};
let activeBarometerTicker = null;
let activeBarometerTimeframe = '1Y';
let activeMasterTimeframe = '5Y';
// activeCustomRange is ONLY used in Latest Snapshot mode for a legacy
// custom date range. In Historical Event mode it MUST remain null so
// that sliceByTimeframe() does not interfere with event horizon slicing.
let activeCustomRange = null;
let macroEvents = [];
let sectorData = {};
let equityData = {};

// ── Shared Authoritative Event Selection State ───────────────
// Authoritative single source of truth used by both main terminal
// (Quadrant 4) and FX & Commodities tab.
const sharedEventState = {
    active: false,           // boolean: true when in historical event mode
    eventIdx: null,          // number | null: index in macroEvents array
    eventId: null,           // string | null: event name or identifier
    event: null,             // object | null: reference to event in macroEvents
    archiveDate: null,       // string | null: e.g. "2014-11-27"
    horizon: '1M',           // '1W' | '1M' | '3M' | '6M' | 'YTD' | '1Y' | '5Y' | 'MAX'
    baselineDate: null,      // string | null: selected pre-event baseline (latest finite price strictly before event)
    baselineAgeDays: null,   // number | null: calendar days between baselineDate and the event date
    firstSessionDate: null,  // string | null: first market session on or after event
    endDate: null,           // string | null: actual ending date of displayed window
    isComplete: true,        // boolean: whether requested horizon is fully populated
    incompleteReason: null   // string | null: explanation when horizon extends beyond history
};

// Deferred-render protection (D8). handleEventSelection schedules the impact
// and sector panels after a short delay. Every selection or reset bumps the
// generation and cancels the pending timer; the callback additionally checks
// its own generation so outdated work can never mutate the current panels.
let eventRenderGeneration = 0;
let pendingEventTimer = null;
function cancelPendingEventRender() {
    eventRenderGeneration++;
    if (pendingEventTimer != null) clearTimeout(pendingEventTimer);
    pendingEventTimer = null;
}

// Legacy/convenience globals kept synchronized with sharedEventState
let activeEventMode = false;
let activeEventIdx = null;
let activeEventHorizon = '1M';
let activeEquityTicker = null;

// Helper to keep both sets of timeframe buttons (barometer and master chart)
// in sync with the current active mode and horizon.
function syncTimeframeButtons() {
    // In event mode the YTD control means the event-year end (Dec 31 of the event year)
    ['.baro-tf-btn', '.master-tf-btn'].forEach(sel => {
        document.querySelectorAll(sel).forEach(btn => {
            if (typeof btn.id === 'string' && btn.id.endsWith('-YTD')) {
                btn.textContent = sharedEventState.active ? 'Event-year end' : 'YTD';
                btn.title = sharedEventState.active ? 'Event-year end: December 31 of the event year' : '';
            }
        });
    });
    if (sharedEventState.active) {
        const h = sharedEventState.horizon;
        document.querySelectorAll('.baro-tf-btn').forEach(btn => {
            btn.classList.toggle('active', btn.id === `baro-tf-${h}`);
        });
        document.querySelectorAll('.master-tf-btn').forEach(btn => {
            btn.classList.toggle('active', btn.id === `master-tf-${h}`);
        });
    } else {
        document.querySelectorAll('.baro-tf-btn').forEach(btn => {
            btn.classList.toggle('active', btn.id === `baro-tf-${activeBarometerTimeframe}`);
        });
        document.querySelectorAll('.master-tf-btn').forEach(btn => {
            btn.classList.toggle('active', btn.id === `master-tf-${activeMasterTimeframe}`);
        });
    }
}


// Per-dataset load results populated by initTerminal
// shape: { status: 'loaded'|'empty'|'failed'|'invalid', latestDate: str|null, count: number, error: str|null }
let datasetStatus = {};

const SECTOR_MAP = {
    'XLK': 'TECHNOLOGY (XLK)', 'XLE': 'ENERGY (XLE)', 'XLF': 'FINANCIALS (XLF)',
    'XLV': 'HEALTHCARE (XLV)', 'XLY': 'CONS. DISC. (XLY)', 'XLI': 'INDUSTRIALS (XLI)',
    'XLB': 'MATERIALS (XLB)', 'XLU': 'UTILITIES (XLU)', 'XLP': 'CONS. STAPLES (XLP)',
    'XLRE': 'REAL ESTATE (XLRE)', 'XLC': 'COMM. SVCS (XLC)'
};

let barometerChart = null;
let masterChart = null;
let equityChart = null;

// ============================================================
// 1. INITIALIZATION
// ============================================================
async function initTerminal() {
    console.log('Kutun Terminal initializing (Stage 1A)…');

    // Each dataset is fetched independently.  A failure in one
    // MUST NOT prevent the others from loading.
    const [commodResult, eventResult, sectorResult, newsResult, equityResult] = await Promise.all([
        fetchDataset('commodities_data.json'),
        fetchDataset('macro_events.json'),
        fetchDataset('sector_historical.json'),
        fetchDataset('live_news.json'),
        fetchDataset('equity_data.json')
    ]);

    // ── Apply commodity data ──────────────────────────────────
    if (commodResult.ok) {
        const d = commodResult.data;
        if (d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length > 0) {
            commodityData = d;
            datasetStatus.commodities = buildCommodityStatus(d);
        } else {
            datasetStatus.commodities = { status: 'empty', latestDates: {}, count: 0, error: null };
        }
    } else {
        datasetStatus.commodities = { status: 'failed', latestDates: {}, count: 0, error: commodResult.error };
    }

    // ── Apply macro events ────────────────────────────────────
    if (eventResult.ok) {
        const d = eventResult.data;
        if (Array.isArray(d) && d.length > 0) {
            macroEvents = d;
            datasetStatus.events = { status: 'loaded', count: d.length, error: null };
        } else {
            datasetStatus.events = { status: 'empty', count: 0, error: null };
        }
    } else {
        datasetStatus.events = { status: 'failed', count: 0, error: eventResult.error };
    }

    // ── Apply sector data ─────────────────────────────────────
    if (sectorResult.ok) {
        const d = sectorResult.data;
        if (d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length > 0) {
            sectorData = d;
            datasetStatus.sectors = buildSectorStatus(d);
        } else {
            datasetStatus.sectors = { status: 'empty', latestDates: {}, count: 0, error: null };
        }
    } else {
        datasetStatus.sectors = { status: 'failed', latestDates: {}, count: 0, error: sectorResult.error };
    }

    // ── Apply news data ───────────────────────────────────────
    if (newsResult.ok) {
        const d = newsResult.data;
        if (Array.isArray(d) && d.length > 0) {
            datasetStatus.news = buildNewsStatus(d);
            renderLiveNews(d);
        } else {
            datasetStatus.news = { status: 'empty', count: 0, latestPubDate: null, error: null };
            renderLiveNews([]);
        }
    } else {
        datasetStatus.news = { status: 'failed', count: 0, latestPubDate: null, error: newsResult.error };
        renderLiveNews([]);
    }

    // ── Apply equity data ─────────────────────────────────────
    if (equityResult.ok) {
        const d = equityResult.data;
        if (d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length > 0) {
            equityData = d;
            datasetStatus.equities = buildEquityStatus(d);
        } else {
            datasetStatus.equities = { status: 'empty', latestDates: {}, count: 0, error: null };
        }
    } else {
        datasetStatus.equities = { status: 'failed', latestDates: {}, count: 0, error: equityResult.error };
    }

    // ── Build UI ──────────────────────────────────────────────
    renderDataStatusPanel();
    buildBarometerList();
    buildMasterCheckboxes();
    buildMacroEventList();
    buildMacroArchive();
    buildEquityWatchlist();
    resetToToday();

    const firstTicker = Object.keys(commodityData)[0];
    if (firstTicker) selectBarometerCommodity(firstTicker);

    console.log('Terminal initialized.', datasetStatus);
}

// ── Low-level fetch helper ────────────────────────────────────
// Returns { ok: true, data } or { ok: false, error: string }
// Never throws.
// cache: 'no-store' bypasses the HTTP cache so a normal reload reads the
// files currently on disk. A 304 is not treated as stale or as success;
// with no-store the browser should receive a body-bearing response.
const DATASET_FETCH_INIT = { cache: 'no-store' };

async function fetchDataset(url) {
    try {
        const res = await fetch(url, DATASET_FETCH_INIT);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        let data;
        try {
            data = await res.json();
        } catch (parseErr) {
            return { ok: false, error: 'JSON parse error' };
        }
        return { ok: true, data };
    } catch (netErr) {
        return { ok: false, error: netErr.message || 'Network error' };
    }
}

// ── Status builders ───────────────────────────────────────────
// These derive counts and per-instrument dates from actual data.

function buildCommodityStatus(data) {
    const latestDates = {};
    const earliestDates = {};
    let count = 0;
    for (const [name, ds] of Object.entries(data)) {
        if (!ds || !Array.isArray(ds.labels) || !Array.isArray(ds.prices)) continue;
        count++;
        const validDates = ds.labels.filter(d => d && typeof d === 'string');
        if (validDates.length > 0) {
            const sorted = [...validDates].sort();
            earliestDates[name] = sorted[0];
            latestDates[name] = sorted[sorted.length - 1];
        }
    }
    return {
        status: count > 0 ? 'loaded' : 'empty',
        latestDates,   // per-instrument
        earliestDates,
        count,
        error: null
    };
}

function buildSectorStatus(data) {
    const latestDates = {};
    const earliestDates = {};
    let count = 0;
    for (const [ticker, series] of Object.entries(data)) {
        if (!Array.isArray(series) || series.length === 0) continue;
        count++;
        // A null/malformed record must not abort initialisation (and with it every panel).
        const dates = series.map(p => (p !== null && typeof p === 'object') ? p.x : undefined).filter(Boolean).sort();
        if (dates.length > 0) {
            earliestDates[ticker] = dates[0];
            latestDates[ticker] = dates[dates.length - 1];
        }
    }
    return { status: count > 0 ? 'loaded' : 'empty', latestDates, earliestDates, count, error: null };
}

function buildNewsStatus(items) {
    // Publication date of the newest item in the feed.
    // This is NOT a collection timestamp; collection time is unknown
    // unless macro_engine.py embeds it (it does not currently).
    const pubDates = items
        .map(it => it.published_at)
        .filter(d => d && typeof d === 'string' && d.length > 0)
        .sort();
    const latestPubDate = pubDates.length > 0 ? pubDates[pubDates.length - 1] : null;
    return { status: 'loaded', count: items.length, latestPubDate, error: null };
}

function buildEquityStatus(data) {
    const latestDates = {};
    const earliestDates = {};
    let count = 0;
    let invalidCount = 0;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { status: 'invalid', latestDates: {}, earliestDates: {}, count: 0, error: 'Dataset is not an object' };
    }
    for (const [sym, entry] of Object.entries(data)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            invalidCount++;
            continue;
        }
        const prices = entry.historical_prices;
        if (!prices || typeof prices !== 'object' || Array.isArray(prices)) {
            invalidCount++;
            continue;
        }
        const dates = Object.keys(prices).filter(Boolean).sort();
        if (dates.length > 0) {
            earliestDates[sym] = dates[0];
            latestDates[sym] = dates[dates.length - 1];
            count++;
        } else {
            invalidCount++;
        }
    }
    const status = count > 0 ? 'loaded' : (invalidCount > 0 ? 'invalid' : 'empty');
    return { status, latestDates, earliestDates, count, error: null };
}

// ── Freshness helper ──────────────────────────────────────────
// Returns an object describing age relative to STALE_DAYS.
// Does NOT claim exchange-calendar accuracy.
function assessFreshness(latestDateStr) {
    if (!latestDateStr) return { stale: null, ageText: 'date unknown' };
    try {
        const latest = new Date(latestDateStr);
        const now = new Date();
        const ageDays = Math.floor((now - latest) / 86400000);
        const stale = ageDays > STALE_DAYS;
        return {
            stale,
            ageText: `${ageDays}d ago`,
            ageDays
        };
    } catch {
        return { stale: null, ageText: 'date unknown' };
    }
}

// ── Summarise per-instrument date coverage ────────────────────
// Returns a single display string representing coverage range,
// honouring the fact that instruments may have different lengths.
function summariseDateCoverage(latestDates, earliestDates) {
    const latestVals = Object.values(latestDates).filter(Boolean).sort();
    const earliestVals = Object.values(earliestDates || {}).filter(Boolean).sort();
    if (latestVals.length === 0) return 'no dates';
    const oldestLatest = latestVals[0];
    const newestLatest = latestVals[latestVals.length - 1];
    const overallEarliest = earliestVals.length > 0 ? earliestVals[0] : '?';
    if (oldestLatest === newestLatest) {
        return `${overallEarliest} → ${newestLatest}`;
    }
    // Instruments have different latest dates — show the spread
    return `${overallEarliest} → ${oldestLatest}–${newestLatest} (range)`;
}

// ── Data Status Panel ─────────────────────────────────────────
function renderDataStatusPanel() {
    const panel = document.getElementById('data-status-panel');
    if (!panel) return;

    const statusIcon = (st) => {
        if (st === 'loaded') return '<span style="color:var(--green)">●</span>';
        if (st === 'empty')  return '<span style="color:var(--amber)">◐</span>';
        if (st === 'failed') return '<span style="color:var(--red)">✕</span>';
        return '<span style="color:#555">?</span>';
    };

    const statusLabel = (st) => {
        if (st === 'loaded') return 'LOADED';
        if (st === 'empty')  return 'EMPTY';
        if (st === 'failed') return 'FAILED';
        if (st === 'invalid') return 'INVALID';
        return 'UNKNOWN';
    };

    const rows = [];

    // ── Equities ──────────────────────────────────────────────
    {
        const s = datasetStatus.equities || { status: 'failed', count: 0, latestDates: {}, earliestDates: {} };
        const coverage = s.status === 'loaded'
            ? summariseDateCoverage(s.latestDates, s.earliestDates)
            : '—';
        const allLatest = Object.values(s.latestDates || {}).sort();
        const newestLatest = allLatest[allLatest.length - 1] || null;
        const fresh = assessFreshness(newestLatest);
        const ageFlag = s.status === 'loaded' && fresh.stale === true
            ? `<span style="color:var(--amber)" title="Latest observation is more than ${STALE_DAYS} calendar days old. This is NOT an exchange-calendar freshness check."> ⚠ stale</span>`
            : '';
        rows.push(`
            <div class="ds-row">
                <span class="ds-icon">${statusIcon(s.status)}</span>
                <span class="ds-name">EQUITIES</span>
                <span class="ds-badge ${s.status}">${statusLabel(s.status)}</span>
                <span class="ds-detail">${s.count} tickers · ${coverage}${ageFlag}</span>
                <span class="ds-note">Snapshot</span>
            </div>`);
    }

    // ── Sectors ───────────────────────────────────────────────
    {
        const s = datasetStatus.sectors || { status: 'failed', count: 0, latestDates: {}, earliestDates: {} };
        const coverage = s.status === 'loaded'
            ? summariseDateCoverage(s.latestDates, s.earliestDates)
            : '—';
        const allLatest = Object.values(s.latestDates || {}).sort();
        const newestLatest = allLatest[allLatest.length - 1] || null;
        const fresh = assessFreshness(newestLatest);
        const ageFlag = s.status === 'loaded' && fresh.stale === true
            ? `<span style="color:var(--amber)" title="Latest observation is more than ${STALE_DAYS} calendar days old."> ⚠ stale</span>`
            : '';
        rows.push(`
            <div class="ds-row">
                <span class="ds-icon">${statusIcon(s.status)}</span>
                <span class="ds-name">SECTORS</span>
                <span class="ds-badge ${s.status}">${statusLabel(s.status)}</span>
                <span class="ds-detail">${s.count} ETFs · ${coverage}${ageFlag}</span>
                <span class="ds-note">Snapshot</span>
            </div>`);
    }

    // ── Commodities ───────────────────────────────────────────
    {
        const s = datasetStatus.commodities || { status: 'failed', count: 0, latestDates: {}, earliestDates: {} };
        const coverage = s.status === 'loaded'
            ? summariseDateCoverage(s.latestDates, s.earliestDates)
            : '—';
        const allLatest = Object.values(s.latestDates || {}).sort();
        const newestLatest = allLatest[allLatest.length - 1] || null;
        const fresh = assessFreshness(newestLatest);
        const ageFlag = s.status === 'loaded' && fresh.stale === true
            ? `<span style="color:var(--amber)" title="Latest observation is more than ${STALE_DAYS} calendar days old."> ⚠ stale</span>`
            : '';
        rows.push(`
            <div class="ds-row">
                <span class="ds-icon">${statusIcon(s.status)}</span>
                <span class="ds-name">COMMODITIES</span>
                <span class="ds-badge ${s.status}">${statusLabel(s.status)}</span>
                <span class="ds-detail">${s.count} instruments · ${coverage}${ageFlag}</span>
                <span class="ds-note">Snapshot</span>
            </div>`);
    }

    // ── News ──────────────────────────────────────────────────
    {
        const s = datasetStatus.news || { status: 'failed', count: 0, latestPubDate: null };
        let detail = '—';
        if (s.status === 'loaded') {
            const pubStr = s.latestPubDate
                ? `Latest pub: ${s.latestPubDate.slice(0, 10)}`
                : 'publication date unknown';
            detail = `${s.count} item${s.count !== 1 ? 's' : ''} · ${pubStr} · Retrieval time unknown`;
        } else if (s.status === 'empty') {
            detail = '0 items';
        }
        const fresh = s.latestPubDate ? assessFreshness(s.latestPubDate) : { stale: null };
        const ageFlag = s.status === 'loaded' && fresh.stale === true
            ? `<span style="color:var(--amber)"> ⚠ stale</span>`
            : '';
        rows.push(`
            <div class="ds-row">
                <span class="ds-icon">${statusIcon(s.status)}</span>
                <span class="ds-name">NEWS</span>
                <span class="ds-badge ${s.status}">${statusLabel(s.status)}</span>
                <span class="ds-detail">${detail}${ageFlag}</span>
                <span class="ds-note">Run macro_engine.py to refresh</span>
            </div>`);
    }

    // ── Event Archive ─────────────────────────────────────────
    {
        const s = datasetStatus.events || { status: 'failed', count: 0 };
        rows.push(`
            <div class="ds-row">
                <span class="ds-icon">${statusIcon(s.status)}</span>
                <span class="ds-name">EVENT ARCHIVE</span>
                <span class="ds-badge ${s.status}">${statusLabel(s.status)}</span>
                <span class="ds-detail">${s.count} event${s.count !== 1 ? 's' : ''} · Manually curated — not a live feed</span>
                <span class="ds-note">Retrospective only</span>
            </div>`);
    }

    panel.innerHTML = `
        <div class="ds-header">
            <span class="ds-title">DATA STATUS</span>
            <span class="ds-subtitle">Static snapshots · Not streaming · Freshness flag: &gt;${STALE_DAYS} calendar days (not exchange-calendar)</span>
        </div>
        ${rows.join('')}
    `;
}

// ============================================================
// 2. UTILITY — Slice data by timeframe
// ============================================================
// ── Snapshot window policy (documented, timezone-stable) ─────
// Reference date: the rolling windows are anchored to TODAY'S UTC CALENDAR DATE
// (the clock), NOT to the latest observation of each series. A stale series
// therefore shows an explicit empty-window state for short windows instead of
// silently sliding its window back. Every instrument in one chart is sliced
// against the same reference Date (see updateMasterChart).
// Dates are date-only (YYYY-MM-DD). All boundary arithmetic uses UTC day numbers
// and explicit calendar arithmetic, so results do not depend on the machine's
// time zone. A window includes every observation whose date is >= the cutoff date.
//   1W  today - 7 days                 6M  same day 6 months earlier (month-end clamped)
//   1M  same day 1 month earlier       YTD January 1 of today's UTC year
//   3M  same day 3 months earlier      1Y  same day 12 months earlier (Feb 29 -> Feb 28)
//   5Y  same day 60 months earlier     MAX fixed floor 2005-01-01 (not "all history")
// Month-end clamping: 2019-03-31 minus 1 month = 2019-02-28; 2020-03-31 -> 2020-02-29.
// Unknown timeframe falls back to 5Y (existing behaviour).
function utcDayOfDate(date) {
    return Math.floor(date.getTime() / 86400000);
}

function addCalendarMonthsToDay(day, months) {
    const dt = new Date(day * 86400000);
    const total = dt.getUTCFullYear() * 12 + dt.getUTCMonth() + months;
    const ty = Math.floor(total / 12);
    const tm = total - ty * 12;
    const lastOfMonth = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return Math.round(Date.UTC(ty, tm, Math.min(dt.getUTCDate(), lastOfMonth)) / 86400000);
}

function snapshotCutoffDay(timeframe, referenceDate) {
    const refDay = utcDayOfDate(referenceDate);
    switch (timeframe) {
        case '1W':  return refDay - 7;
        case '1M':  return addCalendarMonthsToDay(refDay, -1);
        case '3M':  return addCalendarMonthsToDay(refDay, -3);
        case '6M':  return addCalendarMonthsToDay(refDay, -6);
        case 'YTD': return Math.round(Date.UTC(new Date(refDay * 86400000).getUTCFullYear(), 0, 1) / 86400000);
        case '1Y':  return addCalendarMonthsToDay(refDay, -12);
        case '5Y':  return addCalendarMonthsToDay(refDay, -60);
        case 'MAX': return Math.round(Date.UTC(2005, 0, 1) / 86400000);
        default:    return addCalendarMonthsToDay(refDay, -60);
    }
}

function dayToIso(day) {
    return new Date(day * 86400000).toISOString().slice(0, 10);
}

// Returns { labels, prices, days, noData, seriesInvalid, reason, cutoffDate, latestAvailableDate }
// The series is validated BEFORE slicing with the same helper as event mode
// (buildEventSeriesView): dates and prices are paired and sorted together without
// mutating the source arrays; unequal lengths, invalid calendar dates and duplicate
// dates make the series unavailable (seriesInvalid:true, reason) instead of guessing.
// Invalid prices (null/undefined/NaN/Infinity/strings) stay as null gaps at their dates.
// noData = true when the series is unusable or the requested window contains no
// observations; latestAvailableDate is then the most recent observation date in the
// series so the UI can display an honest message. The window is never widened.
function sliceByTimeframe(labels, prices, timeframe, customRange = activeCustomRange, referenceDate = new Date()) {
    const empty = (extra) => Object.assign({ labels: [], prices: [], days: [], noData: true, seriesInvalid: false, reason: null, latestAvailableDate: null }, extra);
    if (!Array.isArray(labels) || labels.length === 0) {
        return empty({ reason: 'no observations' });
    }
    const view = buildEventSeriesView(labels, prices);
    if (!view.ok) {
        return empty({ seriesInvalid: true, reason: view.reason });
    }
    const latestAvailableDate = view.labels[view.length - 1] || null;

    let startDay, endDay = Infinity, cutoffDate = null;
    if (customRange) {
        const { start, end } = customRange;
        if (start > end) return empty({ reason: 'custom range start is after its end', latestAvailableDate });
        startDay = utcDayOfDate(start);
        endDay = utcDayOfDate(end);
    } else {
        startDay = snapshotCutoffDay(timeframe, referenceDate);
        cutoffDate = dayToIso(startDay);
    }

    const startIdx = view.days.findIndex(d => d >= startDay);
    if (startIdx === -1) {
        return empty({ reason: 'no observations in the requested window', cutoffDate, latestAvailableDate });
    }
    let endIdx = view.length - 1;
    while (endIdx >= startIdx && view.days[endIdx] > endDay) endIdx--;
    if (endIdx < startIdx) {
        return empty({ reason: 'no observations in the requested window', cutoffDate, latestAvailableDate });
    }
    return {
        labels: view.labels.slice(startIdx, endIdx + 1),
        prices: view.prices.slice(startIdx, endIdx + 1),
        days: view.days.slice(startIdx, endIdx + 1),
        noData: false,
        seriesInvalid: false,
        reason: null,
        cutoffDate,
        latestAvailableDate
    };
}

// Calendar-gap screening rule (NOT an exchange-session audit): consecutive source
// observations in a window more than SNAPSHOT_GAP_WARN_DAYS calendar days apart.
// No trading calendar is inferred and no dates/prices are inserted.
const SNAPSHOT_GAP_WARN_DAYS = 7;
function screenCalendarGaps(labels, days) {
    let count = 0, largest = 0, from = null, to = null;
    for (let i = 1; i < days.length; i++) {
        const gap = days[i] - days[i - 1];
        if (gap > SNAPSHOT_GAP_WARN_DAYS) {
            count++;
            if (gap > largest) { largest = gap; from = labels[i - 1]; to = labels[i]; }
        }
    }
    return { count, largestDays: largest, from, to };
}
// ============================================================
// 2b. UTILITY — Slice data by event horizon (Historical Event mode)
// ============================================================
// Returns {
//   labels:               string[]   - chronological date labels (pre-event context + baseline + forward window)
//   prices:               (number|null)[] - price per label; invalid prices are null gaps (never dropped)
//   noData:               boolean    - series/baseline unusable (see reason); labels/prices are then empty
//   reason:               string|null
//   shortReason:          string|null - concise exclusion text for tables/legends
//   seriesInvalid:        boolean    - labels/prices malformed (length mismatch, invalid or duplicate dates)
//   view:                 {labels, days, prices, length}|null - validated chronological series (whole history)
//   baselineIdx:          number     - index in sliced arrays of the baseline
//   baselineRawIdx:       number     - index in `view` of the baseline
//   baselineDate / baselinePrice / baselineAgeDays / baselineSkipped
//                         selected baseline, its calendar-day age before the event, and how many
//                         invalid pre-event records were searched past. When the nearest usable price
//                         is too old, baselineDate is null and baselineCandidateDate/AgeDays name it.
//   returnsAvailable:     boolean    - percentage returns allowed (baseline strictly positive)
//   returnsReason:        string|null
//   firstSessionDate:     string|null - first record on or after the event date
//   endDate:              string|null - actual last date included in the window
//   horizonStatus:        'complete' | 'incomplete' | 'unverified' | 'noforward' | 'unavailable'
//   horizonComplete:      boolean    - horizonStatus === 'complete'
//   coverage / boundaryDate  (event-year end only) 'covered' | 'incomplete' | 'unverified'
//   endpointDate / endpointPrice / endpointUsable / endpointReason
//                         the horizon endpoint and whether it supports a return (valid price; for the
//                         event-year end also no more than 7 days before Dec 31). Independent of coverage.
//   preEventContextCount, contextLimited, requestedObs, actualPostEventObs, incompleteReason,
//   latestAvailableDate
// }
//
// SERIES INTEGRITY (D5/D6): dates and prices are paired and sorted by date
// without mutating the inputs. Unequal lengths, invalid calendar dates and
// duplicate dates make the series unavailable with a reason.
//
// VISUAL CONTEXT:
//   Displays up to 5 observations before the baseline. These earlier points are
//   for visual context only; they never count toward the return horizon and
//   returns are NEVER normalized to the first context point.
//
// RETURN BASELINE CONVENTION (provisional; see selectEventBaseline):
//   Latest finite price strictly before the date-only archive event date,
//   searching past invalid records, at most MAX_EVENT_BASELINE_AGE_DAYS (7)
//   calendar days old. Intraday event timestamps are not used.
//
// HORIZON OBSERVATIONS (counted over the records present, from the baseline):
//   1W: 5   1M: 22   3M: 63   6M: 126   1Y: 252   5Y: 1260   MAX: all after baseline
//   These approximate calendar periods; they do not verify complete sessions.
//   YTD (shown as "Event-year end"): records up to December 31 of the event
//   year; coverage is 'covered' (a record on/after Dec 31 exists), 'unverified'
//   (series ends within 7 days before Dec 31) or 'incomplete'.
function sliceByEventHorizon(labels, prices, eventDateStr, horizon) {
    const requestedLabel = horizon === 'YTD' ? 'event year-end' : horizon;
    let latestAvailableDate = null;
    if (Array.isArray(labels)) {
        const valid = labels.filter(d => parseIsoDateToDay(d) !== null).sort();
        latestAvailableDate = valid.length ? valid[valid.length - 1] : null;
    }

    const fail = (reason, shortReason, incompleteReason, extra) => Object.assign({
        labels: [], prices: [], noData: true, reason, shortReason: shortReason || reason,
        seriesInvalid: false, view: null,
        baselineIdx: -1, baselineRawIdx: -1, baselineDate: null, baselinePrice: null,
        baselineAgeDays: null, baselineSkipped: 0, baselineCandidateDate: null, baselineCandidateAgeDays: null,
        returnsAvailable: false, returnsReason: reason,
        firstSessionDate: null, endDate: null, preEventContextCount: 0, contextLimited: false,
        horizonStatus: 'unavailable', coverage: null, boundaryDate: null,
        endpointDate: null, endpointPrice: null, endpointUsable: false, endpointReason: reason,
        requestedObs: requestedLabel, actualPostEventObs: 0, horizonComplete: false,
        incompleteReason, latestAvailableDate
    }, extra || {});

    if (!Array.isArray(labels) || labels.length === 0 || !eventDateStr) {
        return fail('Empty dataset or missing event date', null, 'No data');
    }

    const view = buildEventSeriesView(labels, prices);
    if (!view.ok) {
        return fail(`Series unavailable: ${view.reason}`, `series invalid: ${view.reason}`, 'Series invalid', { seriesInvalid: true });
    }
    latestAvailableDate = view.labels[view.length - 1];

    const sel = selectEventBaseline(view, eventDateStr);
    if (!sel.ok) {
        return fail(sel.reason, sel.short, sel.incompleteReason, {
            view,
            baselineCandidateDate: sel.candidateDate || null,
            baselineCandidateAgeDays: sel.candidateAgeDays != null ? sel.candidateAgeDays : null,
            baselineSkipped: sel.skipped || 0
        });
    }

    const eventDay = parseIsoDateToDay(eventDateStr);
    const baselineRawIdx = sel.idx;
    const baselineDate = sel.date;
    const baselinePrice = sel.price;
    const returnsAvailable = baselinePrice > 0;
    const returnsReason = returnsAvailable ? null
        : `Percentage returns need a strictly positive baseline; the baseline on ${baselineDate} is ${baselinePrice}`;

    // First record on or after the event date
    let firstSessionDate = null;
    for (let i = 0; i < view.length; i++) {
        if (view.days[i] >= eventDay) { firstSessionDate = view.labels[i]; break; }
    }

    // Up to 5 pre-baseline context records (display only)
    const MAX_CONTEXT = 5;
    const contextStart = Math.max(0, baselineRawIdx - MAX_CONTEXT);
    const preEventContextCount = baselineRawIdx - contextStart;
    const contextLimited = preEventContextCount < MAX_CONTEXT;

    let forwardEnd;                 // exclusive slice end (view index + 1 of the last plotted record)
    let horizonStatus = 'complete';
    let incompleteReason = null;
    let requestedObs = requestedLabel;
    let coverage = null;
    let boundaryDate = null;
    let endpointIdx;
    let endpointUsable;
    let endpointReason = null;

    if (horizon === 'MAX') {
        forwardEnd = view.length;
        requestedObs = 'all';
        endpointIdx = view.length - 1;
        if (endpointIdx <= baselineRawIdx) {
            horizonStatus = 'noforward';
            incompleteReason = 'No observations after the baseline';
        }
    } else if (horizon === 'YTD') {
        const eventYear = eventDateStr.slice(0, 4);
        boundaryDate = `${eventYear}-12-31`;
        const boundaryDay = parseIsoDateToDay(boundaryDate);
        let lastLE = -1;
        for (let i = view.length - 1; i >= 0; i--) {
            if (view.days[i] <= boundaryDay) { lastLE = i; break; }
        }
        const dataEndDay = view.days[view.length - 1];
        const gap = boundaryDay - dataEndDay;
        coverage = gap <= 0 ? 'covered' : (gap <= EVENT_YEAR_END_TOLERANCE_DAYS ? 'unverified' : 'incomplete');
        if (lastLE <= baselineRawIdx) {
            forwardEnd = baselineRawIdx + 1;
            endpointIdx = baselineRawIdx;
            horizonStatus = 'noforward';
            incompleteReason = `No post-baseline observations available in event calendar year ${eventYear} (up to ${boundaryDate})`;
        } else {
            forwardEnd = lastLE + 1;
            endpointIdx = lastLE;
            if (coverage === 'covered') {
                horizonStatus = 'complete';
            } else if (coverage === 'unverified') {
                horizonStatus = 'unverified';
                incompleteReason = `Year-end coverage unverified: data ends ${view.labels[view.length - 1]}, within ${EVENT_YEAR_END_TOLERANCE_DAYS} days before ${boundaryDate}; without an exchange calendar this cannot be confirmed as the final session`;
            } else {
                horizonStatus = 'incomplete';
                incompleteReason = `Data ends ${view.labels[view.length - 1]}, before event-year end ${boundaryDate}`;
            }
        }
    } else {
        const obsCount = EVENT_HORIZON_OBS[horizon] || 22;
        requestedObs = obsCount;
        const desiredEnd = baselineRawIdx + obsCount;
        if (desiredEnd >= view.length) {
            forwardEnd = view.length;
            endpointIdx = view.length - 1;
            const availableObs = view.length - 1 - baselineRawIdx;
            horizonStatus = availableObs > 0 ? 'incomplete' : 'noforward';
            incompleteReason = `Requested ${obsCount} trading obs (${horizon}), but history ends after ${availableObs} obs`;
        } else {
            forwardEnd = desiredEnd + 1;
            endpointIdx = desiredEnd;
        }
    }

    const endpointPrice = view.prices[endpointIdx];
    const endpointDate = view.labels[endpointIdx];
    if (endpointIdx <= baselineRawIdx) {
        endpointUsable = false;
        endpointReason = 'no observation after the baseline';
    } else if (endpointPrice === null) {
        endpointUsable = false;
        endpointReason = 'price missing or invalid';
    } else if (horizon === 'YTD' && parseIsoDateToDay(boundaryDate) - view.days[endpointIdx] > EVENT_YEAR_END_TOLERANCE_DAYS) {
        endpointUsable = false;
        endpointReason = `endpoint ${endpointDate} is more than ${EVENT_YEAR_END_TOLERANCE_DAYS} days before event-year end ${boundaryDate}`;
    } else {
        endpointUsable = true;
    }

    const slicedLabels = view.labels.slice(contextStart, forwardEnd);
    const slicedPrices = view.prices.slice(contextStart, forwardEnd);
    const actualPostEventObs = forwardEnd - 1 - baselineRawIdx;

    return {
        labels: slicedLabels,
        prices: slicedPrices,
        noData: false,
        reason: null,
        shortReason: null,
        seriesInvalid: false,
        view,
        baselineIdx: baselineRawIdx - contextStart,
        baselineRawIdx,
        baselineDate,
        baselinePrice,
        baselineAgeDays: sel.ageDays,
        baselineSkipped: sel.skipped,
        baselineCandidateDate: null,
        baselineCandidateAgeDays: null,
        returnsAvailable,
        returnsReason,
        firstSessionDate,
        endDate: slicedLabels[slicedLabels.length - 1] || null,
        preEventContextCount,
        contextLimited,
        horizonStatus,
        coverage,
        boundaryDate,
        endpointDate,
        endpointPrice,
        endpointUsable,
        endpointReason,
        requestedObs,
        actualPostEventObs,
        horizonComplete: horizonStatus === 'complete',
        incompleteReason,
        latestAvailableDate
    };
}


// ============================================================
function buildBarometerList() {
    const list = document.getElementById('barometer-list');
    if (!list) return;
    list.innerHTML = '';
    if (Object.keys(commodityData).length === 0) {
        list.innerHTML = '<div class="commodity-item" style="color:#666">No data</div>';
        return;
    }
    Object.keys(commodityData).forEach(name => {
        const item = document.createElement('div');
        item.className = 'commodity-item';
        item.id = `bitem-${name.replace(/\s+/g, '-')}`;
        item.textContent = name;
        item.onclick = () => selectBarometerCommodity(name);
        list.appendChild(item);
    });
}

function selectBarometerCommodity(name) {
    activeBarometerTicker = name;
    document.querySelectorAll('.commodity-item').forEach(el => el.classList.remove('active'));
    const el = document.getElementById(`bitem-${name.replace(/\s+/g, '-')}`);
    if (el) el.classList.add('active');
    renderBarometerChart(name, sharedEventState.active ? sharedEventState.horizon : activeBarometerTimeframe);
}

function setSharedEventHorizon(tf) {
    sharedEventState.horizon = tf;
    activeEventHorizon = tf;
    syncTimeframeButtons();
    updateMasterChart();
    if (activeBarometerTicker) {
        renderBarometerChart(activeBarometerTicker, tf);
    }
    if (sharedEventState.archiveDate) {
        calculateImpactMetrics(sharedEventState.archiveDate);
        calculateSectorBacktest(sharedEventState.archiveDate);
    }
}

function setBarometerTimeframe(tf) {
    if (sharedEventState.active) {
        // In Historical Event mode, controls the shared event horizon across both tabs
        setSharedEventHorizon(tf);
    } else {
        // Latest Snapshot mode
        activeBarometerTimeframe = tf;
        syncTimeframeButtons();
        if (activeBarometerTicker) renderBarometerChart(activeBarometerTicker, tf);
    }
}

function setMasterTimeframe(tf) {
    if (sharedEventState.active) {
        // In Historical Event mode, controls the shared event horizon across both tabs
        setSharedEventHorizon(tf);
    } else {
        // Latest Snapshot mode — standard rolling window behaviour
        activeMasterTimeframe = tf;
        activeCustomRange = null;
        syncTimeframeButtons();
        updateMasterChart();
    }
}

function renderBarometerChart(name, timeframe) {
    const dataset = commodityData[name];
    const wrap = document.getElementById('barometer-canvas-wrap');
    const canvas = document.getElementById('barometer-canvas');

    if (barometerChart) { barometerChart.destroy(); barometerChart = null; }
    setSnapshotContext('barometer', ''); // re-set below only for a drawn Latest Snapshot chart

    if (!dataset || !Array.isArray(dataset.labels)) {
        showChartMessage(wrap, canvas, `No data available for "${name}"`);
        return;
    }

    let sliced;
    let titleExtra = '';

    if (sharedEventState.active && sharedEventState.archiveDate) {
        // ── Historical Event Mode ──
        sliced = sliceByEventHorizon(dataset.labels, dataset.prices, sharedEventState.archiveDate, sharedEventState.horizon);
        const eventName = sharedEventState.event ? sharedEventState.event.name : sharedEventState.archiveDate;
        titleExtra = ` · EVENT: ${eventName} (${eventHorizonLabel(sharedEventState.horizon)})`;

        if (sliced.noData) {
            showChartMessage(wrap, canvas, `No data for "${name}" near event ${sharedEventState.archiveDate}. (${sliced.reason || 'Baseline unavailable'})`);
            const titleEl = document.getElementById('barometer-chart-title');
            if (titleEl) titleEl.textContent = `${name.toUpperCase()}${titleExtra}`;
            return;
        }
    } else {
        // ── Latest Snapshot Mode ──
        // Validated (paired, sorted; unequal lengths / invalid or duplicate dates rejected) before slicing.
        sliced = sliceByTimeframe(dataset.labels, dataset.prices, timeframe);

        if (sliced.seriesInvalid) {
            showChartMessage(wrap, canvas, `Price series for "${name}" is unavailable: ${sliced.reason}`);
            const titleEl = document.getElementById('barometer-chart-title');
            if (titleEl) titleEl.textContent = name.toUpperCase();
            return;
        }
        if (sliced.noData) {
            const msg = sliced.latestAvailableDate
                ? `No data in this period — latest available: ${sliced.latestAvailableDate}`
                : 'No data in this period';
            showChartMessage(wrap, canvas, msg);
            const titleEl = document.getElementById('barometer-chart-title');
            if (titleEl) titleEl.textContent = name.toUpperCase();
            return;
        }
    }

    // Restore canvas visibility
    if (canvas) canvas.style.display = '';
    const existingMsg = wrap ? wrap.querySelector('.chart-no-data-msg') : null;
    if (existingMsg) existingMsg.remove();

    const baselineDate = sliced.baselineDate;
    const firstPostDate = sliced.firstSessionDate;

    // Visual point markers: highlight baseline in amber
    const snapshotMode = !sharedEventState.active;
    const validAt = (i) => isValidPrice(sliced.prices[i]);
    const pointRadii = sliced.labels.map((d, i) => {
        if (sharedEventState.active && d === baselineDate) return 5;
        // Latest Snapshot: an isolated valid observation (invalid/missing on both sides) stays visible
        if (snapshotMode && validAt(i) && (i === 0 || !validAt(i - 1)) && (i === sliced.labels.length - 1 || !validAt(i + 1))) return 2;
        return 0;
    });
    const pointColors = sliced.labels.map(d => (sharedEventState.active && d === baselineDate) ? '#ffb800' : '#00d1ff');

    // In event mode, invalid prices (null/NaN/Infinity) become gaps, never plotted points.
    // The same gap rule applies to Latest Snapshot: null/NaN/Infinity/numeric strings are
    // never handed to the chart as values. Finite negative prices are plotted as-is.
    const plotPrices = sliced.prices.map(p => isValidPrice(p) ? p : null);

    const ctx = canvas.getContext('2d');
    barometerChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: sliced.labels,
            datasets: [{
                label: name,
                data: plotPrices,
                borderColor: '#00d1ff',
                borderWidth: 1.5,
                pointRadius: pointRadii,
                pointBackgroundColor: pointColors,
                tension: 0.1,
                fill: false,
                // Event mode keeps its existing bridged line. Latest Snapshot breaks the line at explicit
                // invalid points (null); this does not detect absent market sessions.
                spanGaps: !snapshotMode
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index', intersect: false,
                    callbacks: {
                        title: (items) => {
                            const date = items[0]?.label || '';
                            if (sharedEventState.active) {
                                if (date === baselineDate) return `${date}  ← PRE-EVENT BASELINE`;
                                if (date === sharedEventState.archiveDate) return `${date}  ← EVENT DATE`;
                                if (firstPostDate && date === firstPostDate) return `${date}  ← FIRST MARKET SESSION (Event: ${sharedEventState.archiveDate})`;
                            }
                            return date;
                        },
                        label: ctx => isValidPrice(ctx.parsed.y) ? `${ctx.dataset.label}: ${fmtUsd(ctx.parsed.y)}` : `${ctx.dataset.label}: no data`
                    }
                }
            },
            scales: {
                x: { ticks: { color: '#666', maxTicksLimit: 6, font: { family: 'Roboto Mono', size: 10 } }, grid: { color: '#1a1a1a' } },
                y: { ticks: { color: '#666', font: { family: 'Roboto Mono', size: 10 } }, grid: { color: '#1a1a1a' } }
            }
        }
    });

    const titleEl = document.getElementById('barometer-chart-title');
    if (titleEl) titleEl.textContent = `${name.toUpperCase()}${titleExtra}`;

    if (snapshotMode) {
        let lastValid = null;
        for (let i = sliced.prices.length - 1; i >= 0; i--) if (validAt(i)) { lastValid = sliced.labels[i]; break; }
        const invalidN = sliced.prices.filter(p => !isValidPrice(p)).length;
        const gaps = screenCalendarGaps(sliced.labels, sliced.days);
        const parts = [`Window ${timeframe} from ${sliced.cutoffDate || 'custom range'}: ${sliced.labels[0]} → ${sliced.labels[sliced.labels.length - 1]}; last valid price ${lastValid || 'none'}`];
        if (invalidN) parts.push(`${invalidN} invalid price point(s) shown as gaps`);
        if (gaps.count > 0) {
            parts.push(`Calendar-gap screen (more than ${SNAPSHOT_GAP_WARN_DAYS} calendar days between consecutive observations; not an exchange-session audit): largest ${gaps.largestDays} days (${gaps.from} → ${gaps.to})${gaps.count > 1 ? `, ${gaps.count} gaps` : ''}`);
        }
        setSnapshotContext('barometer', parts.join('\n'));
    }
}

// Helper: show a text message in place of a chart without destroying layout.
function showChartMessage(wrap, canvas, message) {
    if (canvas) canvas.style.display = 'none';
    if (!wrap) return;
    let msg = wrap.querySelector('.chart-no-data-msg');
    if (!msg) {
        msg = document.createElement('div');
        msg.className = 'chart-no-data-msg';
        msg.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:0.75rem;text-align:center;padding:12px;font-family:\'Roboto Mono\',monospace;';
        wrap.appendChild(msg);
    }
    msg.textContent = message;
}

// ============================================================
// 4. MASTER CHART (FX Tab) — Multi-series % price-return overlay
// ============================================================
// Note: this chart shows price returns (% change from the
// first observation in the selected window), NOT total returns.
// Total returns would require dividend-adjusted data, which is
// not verified in the current dataset.

const CHART_COLORS = [
    '#00d1ff', '#00ff00', '#ffb800', '#ff4c4c', '#a855f7',
    '#f97316', '#ec4899', '#14b8a6', '#84cc16', '#eab308',
    '#6366f1', '#06b6d4', '#8b5cf6', '#d946ef'
];

let masterRawPrices = {};

function buildMasterCheckboxes() {
    const container = document.getElementById('master-checkboxes');
    if (!container) return;
    container.innerHTML = '';
    if (Object.keys(commodityData).length === 0) {
        container.innerHTML = '<span style="color:#555;font-size:0.8rem;">Commodity data unavailable</span>';
        return;
    }
    Object.keys(commodityData).forEach((name, i) => {
        const color = CHART_COLORS[i % CHART_COLORS.length];
        const label = document.createElement('label');
        label.className = 'checkbox-label';
        const isDefault = (name === 'Gold' || name === 'WTI Crude');
        label.innerHTML = `
            <input type="checkbox" value="${name}" ${isDefault ? 'checked' : ''} onchange="updateMasterChart()">
            <span style="color:${color}">${name}</span>`;
        container.appendChild(label);
    });
}

// Latest-Snapshot percentage series for one instrument over the selected window.
//   Baseline = the first VALID (finite number) price in the window; invalid earlier
//   records (null/undefined/NaN/Infinity/numeric strings) are skipped, never coerced.
//   The baseline must be strictly positive (same rule as computePriceReturn): a zero or
//   negative first valid price makes every percentage unavailable - no later price is
//   substituted. A window with only one usable (valid) observation cannot produce a
//   measured return — that is disclosed, never plotted as 0.00%. Invalid points become
//   null gaps. Returns { ok, reason, pct: (number|null)[], baselineIdx, baselinePrice };
//   pct has the same length as `prices` and is all-null when ok is false (unavailable,
//   never a flat 0% line). Optional `labels` supplies the observation date in the reason.
function singleObservationUnavailableReason(date) {
    const d = date != null && date !== '' ? String(date) : '';
    return d ? `Single observation ${d}; return unavailable.` : 'Single observation; return unavailable.';
}

function computeSnapshotPercentSeries(prices, labels) {
    if (!Array.isArray(prices) || prices.length === 0) {
        return { ok: false, reason: 'no observations', pct: [], baselineIdx: -1, baselinePrice: null };
    }
    const allNull = () => prices.map(() => null);
    const baselineIdx = prices.findIndex(isValidPrice);
    if (baselineIdx < 0) {
        return { ok: false, reason: 'no valid price in the window', pct: allNull(), baselineIdx: -1, baselinePrice: null };
    }
    const baselinePrice = prices[baselineIdx];
    const basis = computePriceReturn(baselinePrice, baselinePrice);
    if (!basis.ok) {
        return { ok: false, reason: basis.reason, pct: allNull(), baselineIdx, baselinePrice };
    }
    let usable = 0;
    for (let i = 0; i < prices.length; i++) if (isValidPrice(prices[i])) usable++;
    if (usable === 1) {
        const date = Array.isArray(labels) && labels[baselineIdx] != null ? labels[baselineIdx] : '';
        return { ok: false, reason: singleObservationUnavailableReason(date), pct: allNull(), baselineIdx, baselinePrice };
    }
    const pct = prices.map(p => {
        const r = computePriceReturn(baselinePrice, p);
        // `+ 0` turns a rounded -0 into 0 so a true unchanged price reads +0.00%
        return r.ok ? parseFloat(r.pct.toFixed(3)) + 0 : null;
    });
    return { ok: true, reason: null, pct, baselineIdx, baselinePrice };
}

// Array-only view of computeSnapshotPercentSeries (kept for callers/tests that want
// just the values). Unavailable series come back as all-null, not 0%.
function toPercentChange(prices) {
    return computeSnapshotPercentSeries(prices).pct;
}

// Chart.js index mode pairs dataset[i][dataIndex] across instruments. Sparse
// {x,y} series of different lengths then mix dates. Hover matching is by each
// point's own observation date (raw.x, else axis label / labels[dataIndex]).
const SNAPSHOT_CHART_INTERACTION = { mode: 'nearest', axis: 'x', intersect: false };

function observationDateOf(item, labels) {
    if (!item) return '';
    const raw = Object.prototype.hasOwnProperty.call(item, 'raw') ? item.raw : item;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.x != null && raw.x !== '') {
        return String(raw.x);
    }
    if (item.label != null && item.label !== '') return String(item.label);
    const idx = item.dataIndex;
    if (Array.isArray(labels) && Number.isInteger(idx) && labels[idx] != null) return String(labels[idx]);
    return '';
}

function tooltipItemObservationY(item) {
    if (item && item.parsed && Object.prototype.hasOwnProperty.call(item.parsed, 'y')) return item.parsed.y;
    const raw = item && Object.prototype.hasOwnProperty.call(item, 'raw') ? item.raw : item;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, 'y')) return raw.y;
    return raw;
}

function tooltipItemHasObservation(item) {
    const y = tooltipItemObservationY(item);
    if (isValidPrice(y)) return true;
    const date = observationDateOf(item);
    const obs = item && item.dataset && item.dataset.kutunObs;
    return !!(obs && obs[date] === 'invalid');
}

function tooltipFilterSameDate(item, _index, items) {
    const anchor = (items && items.length) ? items[0] : item;
    const hovered = observationDateOf(anchor) || (item && item.label != null ? String(item.label) : '');
    if (!hovered || observationDateOf(item) !== hovered) return false;
    return tooltipItemHasObservation(item);
}

// Walks each dataset for the point whose observation date is `date`. Never
// uses a shared array index to pair instruments. Missing observations omitted.
function tooltipItemsAtDate(chartData, date) {
    const want = String(date);
    const labels = (chartData && chartData.labels) || [];
    const out = [];
    ((chartData && chartData.datasets) || []).forEach((ds, datasetIndex) => {
        const data = ds.data || [];
        for (let i = 0; i < data.length; i++) {
            const item = {
                raw: data[i],
                dataIndex: i,
                label: labels[i] != null ? String(labels[i]) : '',
                dataset: ds,
                parsed: { y: (data[i] && typeof data[i] === 'object' && !Array.isArray(data[i]) && 'y' in data[i]) ? data[i].y : data[i] }
            };
            if (observationDateOf(item, labels) !== want) continue;
            if (!tooltipFilterSameDate(Object.assign({}, item, { label: want }))) continue;
            out.push({ datasetIndex, dataIndex: i, date: want, y: tooltipItemObservationY(item), label: ds.label });
            break;
        }
    });
    return out;
}

function updateMasterChart() {
    const checked = Array.from(document.querySelectorAll('#master-checkboxes input:checked'))
        .map(cb => cb.value);

    if (masterChart) { masterChart.destroy(); masterChart = null; }

    const masterWrap = document.getElementById('master-canvas-wrap');
    const masterCanvas = document.getElementById('master-canvas');

    if (checked.length === 0) {
        showChartMessage(masterWrap, masterCanvas, 'Select at least one instrument to begin comparison.');
        updateMasterChartSubtitle('');
        setSnapshotContext('master', '');
        return;
    }

    masterRawPrices = {};

    if (sharedEventState.active && sharedEventState.archiveDate) {
        // ── HISTORICAL EVENT MODE ──
        setSnapshotContext('master', ''); // snapshot window/baseline context never shows in event mode
        const event = sharedEventState.event || { name: 'Historical Event', date: sharedEventState.archiveDate };
        const eventDateStr = sharedEventState.archiveDate;
        const horizon = sharedEventState.horizon;

        const eligibleSeries = [];
        const excludedSeries = [];
        const allDatesSet = new Set();

        checked.forEach(name => {
            const dataset = commodityData[name];
            if (!dataset || !Array.isArray(dataset.labels) || dataset.labels.length === 0) {
                excludedSeries.push({ name, reason: 'Dataset missing or empty' });
                return;
            }

            const sliced = sliceByEventHorizon(dataset.labels, dataset.prices, eventDateStr, horizon);
            if (sliced.noData) {
                excludedSeries.push({ name, reason: sliced.reason || 'No valid pre-event baseline' });
                return;
            }
            if (!sliced.returnsAvailable) {
                // Zero/negative baseline: a percentage chart is meaningless. The raw-price
                // barometer chart still shows this series.
                excludedSeries.push({ name, reason: `Percentage returns unavailable: ${sliced.returnsReason}` });
                return;
            }

            const basePrice = sliced.baselinePrice;
            const datePctMap = {};
            const datePriceMap = {};

            sliced.labels.forEach((d, idx) => {
                const p = sliced.prices[idx];
                // Normalize strictly to instrument's own baseline: baseline = 0.00%
                // return = (endpoint price / baseline price) - 1
                // Invalid points (null/NaN/Infinity/strings) are left as gaps.
                const r = computePriceReturn(basePrice, p);
                if (r.ok) {
                    datePctMap[d] = parseFloat(r.pct.toFixed(3));
                    datePriceMap[d] = p;
                    allDatesSet.add(d);
                }
            });

            masterRawPrices[name] = datePriceMap;
            eligibleSeries.push({
                name,
                sliced,
                datePctMap,
                basePrice,
                baselineDate: sliced.baselineDate,
                baselineAgeDays: sliced.baselineAgeDays,
                firstSessionDate: sliced.firstSessionDate,
                endDate: sliced.endDate,
                horizonComplete: sliced.horizonComplete,
                horizonStatus: sliced.horizonStatus,
                incompleteReason: sliced.incompleteReason
            });
        });

        if (eligibleSeries.length === 0) {
            const reasons = excludedSeries.map(e => `${e.name}: ${e.reason}`).join('; ');
            showChartMessage(masterWrap, masterCanvas, `No eligible commodity series for event ${eventDateStr}. (${reasons})`);
            updateMasterChartSubtitle(`All selected series excluded: ${reasons}`);
            return;
        }

        // Restore canvas visibility
        if (masterCanvas) masterCanvas.style.display = '';
        const oldMsg = masterWrap ? masterWrap.querySelector('.chart-no-data-msg') : null;
        if (oldMsg) oldMsg.remove();

        const masterLabels = Array.from(allDatesSet).sort();

        // Establish shared baseline date & end date for subtitle and tooltips
        const primary = eligibleSeries[0];
        sharedEventState.baselineDate = primary.baselineDate;
        sharedEventState.baselineAgeDays = primary.baselineAgeDays;
        sharedEventState.firstSessionDate = primary.firstSessionDate;
        sharedEventState.endDate = primary.endDate;
        sharedEventState.isComplete = eligibleSeries.every(s => s.horizonComplete);
        sharedEventState.incompleteReason = eligibleSeries.find(s => !s.horizonComplete)?.incompleteReason || null;

        const datasets = [];
        // Each series is normalised to ITS OWN baseline (they can differ by instrument)
        const baselineDateSet = new Set(eligibleSeries.map(s => s.baselineDate));

        eligibleSeries.forEach(s => {
            const colorIndex = Object.keys(commodityData).indexOf(s.name) % CHART_COLORS.length;
            const color = CHART_COLORS[colorIndex];

            // Highlight pre-event baseline with a distinct point marker
            const pointRadii = masterLabels.map(d => d === s.baselineDate ? 5 : 0);
            const pointColors = masterLabels.map(d => d === s.baselineDate ? '#ffb800' : color);

            const alignedData = masterLabels.map(d => {
                const y = s.datePctMap[d];
                return y !== undefined ? y : null;
            });

            const incompleteTag = s.horizonComplete ? '' : (s.horizonStatus === 'unverified' ? ' [Year-end unverified]' : ' [Incomplete]');
            datasets.push({
                label: `${s.name}${incompleteTag}`,
                data: alignedData,
                borderColor: color,
                borderWidth: 1.5,
                pointRadius: pointRadii,
                pointBackgroundColor: pointColors,
                tension: 0.1,
                fill: false,
                spanGaps: false // Preserve genuine gaps
            });
        });

        // Show excluded series in legend as dashed lines with reason
        excludedSeries.forEach(e => {
            datasets.push({
                label: `${e.name} (Excluded: ${e.reason})`,
                data: masterLabels.map(() => null),
                borderColor: '#555',
                borderWidth: 1,
                borderDash: [3, 3],
                pointRadius: 0,
                fill: false,
                spanGaps: false
            });
        });

        const ctx = masterCanvas.getContext('2d');
        masterChart = new Chart(ctx, {
            type: 'line',
            data: { labels: masterLabels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: SNAPSHOT_CHART_INTERACTION,
                plugins: {
                    legend: {
                        display: true,
                        labels: { color: '#aaa', font: { family: 'Roboto Mono', size: 11 }, boxWidth: 12 }
                    },
                    tooltip: {
                        filter: tooltipFilterSameDate,
                        callbacks: {
                            title: (items) => {
                                const date = observationDateOf(items[0]) || items[0]?.label || '';
                                if (baselineDateSet.has(date)) {
                                    return `${date}  ← PRE-EVENT BASELINE (Normalized to 0.00%)`;
                                }
                                if (date === eventDateStr) {
                                    return `${date}  ← EVENT DATE (${event.name})`;
                                }
                                if (sharedEventState.firstSessionDate && date === sharedEventState.firstSessionDate) {
                                    return `${date}  ← FIRST MARKET SESSION (Event Date: ${eventDateStr})`;
                                }
                                return date;
                            },
                            label: ctx => {
                                const rawLabel = ctx.dataset.label;
                                const cleanName = rawLabel.replace(/ \[(Incomplete|Year-end unverified)\]$/, '').replace(/ \(Excluded: .*\)$/, '');
                                const pct = ctx.parsed.y;
                                if (pct === null || pct === undefined) return `${rawLabel}: no observation`;
                                const date = observationDateOf(ctx) || ctx.label;
                                const raw = masterRawPrices[cleanName]?.[date];
                                const rawStr = isValidPrice(raw) ? `  (${fmtUsd(raw)})` : '';
                                const sign = pct >= 0 ? '+' : '';
                                return `${cleanName}: ${sign}${pct.toFixed(2)}% price return vs baseline${rawStr}`;
                            }
                        }
                    }
                },
                scales: {
                    x: { type: 'category', ticks: { color: '#666', maxTicksLimit: 8, font: { family: 'Roboto Mono', size: 10 } }, grid: { color: '#1a1a1a' } },
                    y: {
                        ticks: { color: '#666', font: { family: 'Roboto Mono', size: 10 }, callback: val => `${val >= 0 ? '+' : ''}${val.toFixed(1)}%` },
                        grid: { color: '#1a1a1a' }
                    }
                }
            }
        });

        // Subtitle with full auditable event metadata
        const firstNotComplete = eligibleSeries.find(s => !s.horizonComplete);
        const coverageText = sharedEventState.isComplete ? 'Complete'
            : `${firstNotComplete && firstNotComplete.horizonStatus === 'unverified' ? 'YEAR-END UNVERIFIED' : 'INCOMPLETE'} (${sharedEventState.incompleteReason || 'insufficient data'})`;
        const distinctBaselines = Array.from(baselineDateSet);
        const baselineText = distinctBaselines.length === 1
            ? `Baseline: ${distinctBaselines[0]} (latest finite price strictly before event; ${primary.baselineAgeDays} day(s) before event)`
            : `Baselines differ by instrument: ${eligibleSeries.map(s => `${s.name} ${s.baselineDate}`).join(', ')}`;
        const sessionNote = (sharedEventState.firstSessionDate && sharedEventState.firstSessionDate !== eventDateStr)
            ? `First post-event session: ${sharedEventState.firstSessionDate} · `
            : '';
        const subtitleParts = [
            `EVENT: ${event.name} (${eventDateStr})`,
            baselineText,
            `${sessionNote}Horizon: ${eventHorizonLabel(horizon)}`,
            `Window End: ${sharedEventState.endDate || 'N/A'} [${coverageText}]`,
            `Visual Context: up to 5 trading obs prior to baseline`,
            `Returns: price return normalized to instrument's own baseline (0.00%) · Intraday timestamps unavailable`
        ];
        updateMasterChartSubtitle(subtitleParts.join('  ·  '));

    } else {
        // ── LATEST SNAPSHOT MODE ──
        updateMasterChartSubtitle('');

        // One reference clock for EVERY instrument in this render, so that no series is
        // anchored to a different "today" (windows are UTC-date based, see sliceByTimeframe).
        const refDate = new Date();
        const refIso = dayToIso(utcDayOfDate(refDate));

        const rawDatasets = checked.map(name => {
            const dataset = commodityData[name];
            if (!dataset || !Array.isArray(dataset.labels)) return { name, labels: [], prices: [], days: [], noData: true, latestAvailableDate: null };
            // A malformed series is unavailable on its own; the other selected series still render.
            if (!Array.isArray(dataset.prices)) {
                return { name, labels: [], prices: [], days: [], noData: false, invalid: 'prices missing', latestAvailableDate: null };
            }
            // Validated (paired, sorted, duplicate/invalid-date checked) BEFORE slicing.
            const sliced = sliceByTimeframe(dataset.labels, dataset.prices, activeMasterTimeframe, activeCustomRange, refDate);
            return {
                name, labels: sliced.labels, prices: sliced.prices, days: sliced.days,
                noData: sliced.noData && !sliced.seriesInvalid,
                invalid: sliced.seriesInvalid ? sliced.reason : null,
                cutoffDate: sliced.cutoffDate, latestAvailableDate: sliced.latestAvailableDate
            };
        });

        // Check if ALL selected series have no data in this window
        const allEmpty = rawDatasets.every(rd => rd.noData);
        if (allEmpty) {
            const latestDates = rawDatasets.map(rd => rd.latestAvailableDate).filter(Boolean).sort();
            const latestStr = latestDates.length > 0 ? `Latest available: ${latestDates[latestDates.length - 1]}` : '';
            const cutoff = (rawDatasets.find(rd => rd.cutoffDate) || {}).cutoffDate;
            showChartMessage(masterWrap, masterCanvas, `No data in this period — ${latestStr}${cutoff ? ` (${activeMasterTimeframe} window starts ${cutoff})` : ''}`);
            setSnapshotContext('master', '');
            return;
        }

        // Percentage series per instrument, computed on the instrument's OWN records in its
        // window (shared rules: valid finite prices only, strictly positive baseline).
        // Another instrument's dates therefore never enter this series' calculation.
        rawDatasets.forEach(rd => {
            rd.pctResult = null;
            if (rd.noData || rd.invalid) return;
            rd.datePriceMap = {};
            rd.obs = {};                       // date -> 'valid' | 'invalid' (absent date = no observation)
            rd.labels.forEach((d, idx) => {
                rd.datePriceMap[d] = rd.prices[idx];
                rd.obs[d] = isValidPrice(rd.prices[idx]) ? 'valid' : 'invalid';
            });
            rd.pctResult = computeSnapshotPercentSeries(rd.prices, rd.labels);
        });

        // Shared x axis = sorted union of the usable series' actual dates. Dates a series does
        // not have are simply absent from ITS data (never filled or interpolated).
        const allDates = new Set();
        rawDatasets.forEach(rd => { if (!rd.noData && !rd.invalid) rd.labels.forEach(d => allDates.add(d)); });
        const masterLabels = Array.from(allDates).sort();

        const plottable = rawDatasets.filter(rd => rd.pctResult && rd.pctResult.ok);
        if (plottable.length === 0) {
            const reasons = rawDatasets.map(rd => `${rd.name}: ${rd.invalid || (rd.pctResult && rd.pctResult.reason) || 'no data in this period'}`).join('; ');
            showChartMessage(masterWrap, masterCanvas, `Percentage returns unavailable for the selected series — ${reasons}`);
            setSnapshotContext('master', '');
            return;
        }

        // Restore canvas visibility (recovery from empty window)
        if (masterCanvas) masterCanvas.style.display = '';
        const oldMsg = masterWrap ? masterWrap.querySelector('.chart-no-data-msg') : null;
        if (oldMsg) oldMsg.remove();

        const baselineMarkers = {}; // date -> [series names normalised to 0% on that date]
        const datasets = rawDatasets.map((rd, i) => {
            const colorIndex = Object.keys(commodityData).indexOf(rd.name) % CHART_COLORS.length;
            const color = CHART_COLORS[colorIndex];

            if (rd.invalid || (rd.pctResult && !rd.pctResult.ok)) {
                // Unavailable percentage series: listed in the legend with the reason, no points.
                return {
                    label: `${rd.name} (N/A: ${rd.invalid || rd.pctResult.reason})`,
                    data: masterLabels.map(d => ({ x: d, y: null })),
                    borderColor: '#555',
                    borderWidth: 1,
                    borderDash: [3, 3],
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    spanGaps: false
                };
            }

            if (rd.noData) {
                return {
                    label: `${rd.name} (no data in period)`,
                    data: masterLabels.map(d => ({ x: d, y: null })),
                    borderColor: color,
                    borderWidth: 1,
                    borderDash: [4, 4],
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    spanGaps: false
                };
            }

            masterRawPrices[rd.name] = rd.datePriceMap;

            // One point per ACTUAL observation of this instrument, at its own date. An invalid
            // price is an explicit null point (the line breaks there: spanGaps=false). Dates the
            // instrument does not have are absent, not nulls, so different calendars do not
            // fragment the line.
            const data = rd.labels.map((d, idx) => ({ x: d, y: rd.pctResult.pct[idx] }));
            const baseIdx = rd.pctResult.baselineIdx;
            if (baseIdx >= 0) (baselineMarkers[rd.labels[baseIdx]] = baselineMarkers[rd.labels[baseIdx]] || []).push(rd.name);
            const radii = data.map((pt, idx) => {
                if (idx === baseIdx) return 4; // amber baseline marker
                const breakBefore = idx === 0 || data[idx - 1].y === null;
                const breakAfter = idx === data.length - 1 || data[idx + 1].y === null;
                return (pt.y !== null && breakBefore && breakAfter) ? 2 : 0; // isolated valid observation stays visible
            });
            return {
                label: rd.name,
                data,
                kutunObs: rd.obs,
                borderColor: color,
                borderWidth: 1.5,
                pointRadius: radii,
                pointBackgroundColor: data.map((pt, idx) => idx === baseIdx ? '#ffb800' : color),
                tension: 0.1,
                fill: false,
                spanGaps: false // explicit invalid points break the line; this does NOT detect absent sessions
            };
        });

        const ctx = masterCanvas.getContext('2d');
        masterChart = new Chart(ctx, {
            type: 'line',
            data: { labels: masterLabels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: SNAPSHOT_CHART_INTERACTION,
                plugins: {
                    legend: {
                        display: true,
                        labels: { color: '#aaa', font: { family: 'Roboto Mono', size: 11 }, boxWidth: 12 }
                    },
                    tooltip: {
                        filter: tooltipFilterSameDate,
                        callbacks: {
                            title: (items) => {
                                const date = observationDateOf(items[0]) || items[0]?.label || '';
                                const who = baselineMarkers[date];
                                return who ? `${date}  ← normalisation baseline (0.00%) of ${who.join(', ')}` : date;
                            },
                            label: ctx => {
                                const name = ctx.dataset.label;
                                const pct = ctx.parsed.y;
                                const date = observationDateOf(ctx) || ctx.label;
                                if (!isValidPrice(pct)) {
                                    const st = ctx.dataset.kutunObs ? ctx.dataset.kutunObs[date] : null;
                                    if (st === 'invalid') return `${name}: no data (invalid price on ${date})`;
                                    if (ctx.dataset.kutunObs && st === undefined) return `${name}: no data (no observation on ${date})`;
                                    return `${name}: no data`;
                                }
                                const raw = masterRawPrices[name]?.[date];
                                const rawStr = isValidPrice(raw) ? `  (${fmtUsd(raw)})` : '';
                                const sign = pct >= 0 ? '+' : '';
                                return `${name}: ${sign}${pct.toFixed(2)}% price return${rawStr}`;
                            }
                        }
                    }
                },
                scales: {
                    x: { type: 'category', ticks: { color: '#666', maxTicksLimit: 8, font: { family: 'Roboto Mono', size: 10 } }, grid: { color: '#1a1a1a' } },
                    y: {
                        ticks: { color: '#666', font: { family: 'Roboto Mono', size: 10 }, callback: val => `${val >= 0 ? '+' : ''}${val.toFixed(1)}%` },
                        grid: { color: '#1a1a1a' }
                    }
                }
            }
        });

        // Compact per-series disclosure under the chart: window, actual normalisation baseline
        // date, last valid displayed price date, unavailable reasons, invalid points, gap screen.
        const availableRd = rawDatasets.filter(rd => rd.pctResult && rd.pctResult.ok);
        const baselineDates = availableRd.map(rd => rd.labels[rd.pctResult.baselineIdx]);
        const lastValidDate = (rd) => {
            for (let i = rd.prices.length - 1; i >= 0; i--) if (isValidPrice(rd.prices[i])) return rd.labels[i];
            return null;
        };
        const lines = [];
        const windowStart = (rawDatasets.find(rd => rd.cutoffDate) || {}).cutoffDate;
        lines.push(`Window ${activeMasterTimeframe}${windowStart ? ` from ${windowStart}` : ''} (today, UTC: ${refIso}). Each series is normalised to its own first finite, positive price in the window.`);
        const distinct = new Set(baselineDates);
        lines.push((distinct.size > 1
            ? 'Instruments use DIFFERENT starting dates (not a common investment period) - baseline → last valid price: '
            : 'Baseline → last valid price: ') +
            availableRd.map(rd => `${rd.name} ${rd.labels[rd.pctResult.baselineIdx]} → ${lastValidDate(rd)}`).join(' · '));
        const unavailable = rawDatasets.filter(rd => !(rd.pctResult && rd.pctResult.ok)).map(rd => {
            if (rd.invalid) return `${rd.name} (${rd.invalid})`;
            if (rd.noData) return `${rd.name} (no observations in the window)`;
            const r = rd.pctResult;
            return `${rd.name} (${r.reason}${r.baselineIdx >= 0 ? `; first finite price ${r.baselinePrice} on ${rd.labels[r.baselineIdx]}` : ''})`;
        });
        if (unavailable.length) lines.push(`Unavailable: ${unavailable.join(' · ')}`);
        const invalidNotes = availableRd.map(rd => ({ n: rd.prices.filter(p => !isValidPrice(p)).length, name: rd.name })).filter(x => x.n > 0);
        if (invalidNotes.length) lines.push(`Invalid price points shown as gaps: ${invalidNotes.map(x => `${x.name} ${x.n}`).join(' · ')}`);
        const gapNotes = availableRd.map(rd => ({ name: rd.name, g: screenCalendarGaps(rd.labels, rd.days) })).filter(x => x.g.count > 0);
        if (gapNotes.length) {
            lines.push(`Calendar-gap screen (more than ${SNAPSHOT_GAP_WARN_DAYS} calendar days between consecutive observations in the window; not an exchange-session audit): ` +
                gapNotes.map(x => `${x.name} largest ${x.g.largestDays} days (${x.g.from} → ${x.g.to})${x.g.count > 1 ? `, ${x.g.count} gaps` : ''}`).join(' · '));
        }
        setSnapshotContext('master', lines.join('\n'));
    }
}

// Compact snapshot-only context line(s) under a chart (created on demand, like the
// master subtitle). Empty text hides it; event mode always clears it.
function setSnapshotContext(kind, text) {
    const wrapId = kind === 'master' ? 'master-canvas-wrap' : 'barometer-canvas-wrap';
    const id = kind === 'master' ? 'master-snapshot-context' : 'barometer-snapshot-context';
    let el = document.getElementById(id);
    if (!el) {
        if (!text) return;
        const wrap = document.getElementById(wrapId);
        if (!wrap || !wrap.parentNode) return;
        el = document.createElement('div');
        el.id = id;
        el.style.cssText = 'font-size:0.62rem;color:#777;font-family:"Roboto Mono",monospace;padding:2px 0;line-height:1.4;word-break:break-word;white-space:pre-line;';
        wrap.parentNode.insertBefore(el, wrap.nextSibling);
    }
    el.textContent = text;
    el.style.display = text ? '' : 'none';
}
// Update the master chart subtitle element (below the chart).
// In event mode shows event metadata; in snapshot mode clears it.
function updateMasterChartSubtitle(text) {
    let el = document.getElementById('master-chart-subtitle');
    if (!el) {
        // Create element if not present — graceful degradation if HTML hasn't been updated
        const wrap = document.getElementById('master-canvas-wrap');
        if (!wrap) return;
        el = document.createElement('div');
        el.id = 'master-chart-subtitle';
        el.style.cssText = 'font-size:0.62rem;color:#555;font-family:"Roboto Mono",monospace;padding:4px 0 2px 0;line-height:1.4;word-break:break-word;';
        wrap.parentNode && wrap.parentNode.insertBefore(el, wrap.nextSibling);
    }
    el.textContent = text;
    el.style.display = text ? '' : 'none';
}



// ============================================================
// 5. LIVE NEWS ENGINE
// ============================================================
function renderLiveNews(newsItems) {
    const globalContainer = document.getElementById('global-news-feed');
    const macroContainer  = document.getElementById('macro-news-full');

    const renderToContainer = (container, items, maxItems) => {
        if (!container) return;
        container.innerHTML = '';

        if (!items || items.length === 0) {
            container.innerHTML = `
                <div class="news-item" style="color:#666;font-size:0.75rem;padding:12px;">
                    No news items in snapshot.<br>
                    To refresh: run <code style="color:var(--amber)">py macro_engine.py</code> from the project folder.
                </div>`;
            return;
        }

        const shown = maxItems ? items.slice(0, maxItems) : items;
        shown.forEach(item => {
            const newsItem = document.createElement('div');
            newsItem.className = 'news-item';

            let timeStr = '——';
            if (item.published_at) {
                try {
                    const d = new Date(item.published_at);
                    if (!isNaN(d)) {
                        timeStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
                                  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                    }
                } catch {}
            }

            const headline = (item.headline || '').toUpperCase();
            const highImpactKws = ['CRASH', 'WAR', 'FED', 'INFLATION', 'SELL-OFF', 'RATE', 'TREASURY'];
            const isHighImpact = highImpactKws.some(kw => headline.includes(kw));
            const badge = isHighImpact
                ? '<span class="impact-badge" style="margin-right:8px;font-size:0.6rem;color:var(--red);border:1px solid var(--red);padding:1px 4px;">HIGH IMPACT</span>'
                : '';

            newsItem.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span class="news-time">${timeStr}</span>${badge}
                </div>
                <a href="${item.link || '#'}" target="_blank">${headline || '[no headline]'}</a>
            `;
            container.appendChild(newsItem);
        });
    };

    renderToContainer(globalContainer, newsItems, 7);
    renderToContainer(macroContainer, newsItems, null);
}

// ============================================================
// 6. HISTORICAL IMPACT ENGINE & SHARED EVENT CONTROLS
// ============================================================
function buildMacroEventList() {
    // 1. Build main page Q4 event list
    const container = document.getElementById('event-list-container');
    if (container) {
        container.innerHTML = '';
        if (macroEvents.length === 0) {
            container.innerHTML = '<div style="padding:12px;color:#555;font-size:0.75rem;">Event archive unavailable.</div>';
        } else {
            macroEvents.forEach((ev, idx) => {
                const btn = document.createElement('div');
                btn.className = 'event-btn';
                btn.textContent = `${ev.date} | ${ev.name}`;
                btn.onclick = () => handleEventSelection(idx);
                container.appendChild(btn);
            });
        }
    }

    // 2. Build FX tab event dropdown
    const fxSelect = document.getElementById('fx-event-select');
    if (fxSelect) {
        fxSelect.innerHTML = '<option value="snapshot">● LATEST SNAPSHOT</option>';
        if (macroEvents.length === 0) {
            const opt = document.createElement('option');
            opt.value = 'none';
            opt.disabled = true;
            opt.textContent = 'Event archive unavailable';
            fxSelect.appendChild(opt);
        } else {
            macroEvents.forEach((ev, idx) => {
                const opt = document.createElement('option');
                opt.value = String(idx);
                opt.textContent = `${ev.date} | ${ev.name}`;
                fxSelect.appendChild(opt);
            });
        }
    }
}

function buildMacroArchive() {
    const container = document.getElementById('macro-archive-container');
    if (!container) return;
    container.innerHTML = '';
    if (macroEvents.length === 0) {
        container.innerHTML = '<div style="padding:20px;color:#444;font-size:0.8rem;text-align:center;">Event archive unavailable.</div>';
        return;
    }
    macroEvents.forEach(ev => {
        const card = document.createElement('div');
        card.className = 'macro-event-card';
        card.innerHTML = `
            <div class="macro-event-header" onclick="this.parentElement.classList.toggle('expanded')">
                <span class="macro-event-date">${ev.date}</span>
                <span class="macro-event-title">${ev.name}</span>
            </div>
            <div class="macro-event-body">${ev.description || ''}</div>
        `;
        container.appendChild(card);
    });
}

function resetToToday() {
    // Invalidate any pending deferred event panels before touching state (D8)
    cancelPendingEventRender();

    // Deactivate shared event state globally
    sharedEventState.active = false;
    sharedEventState.eventIdx = null;
    sharedEventState.eventId = null;
    sharedEventState.event = null;
    sharedEventState.archiveDate = null;
    sharedEventState.baselineDate = null;
    sharedEventState.baselineAgeDays = null;
    sharedEventState.firstSessionDate = null;
    sharedEventState.endDate = null;
    sharedEventState.isComplete = true;
    sharedEventState.incompleteReason = null;

    activeEventMode = false;
    activeEventIdx = null;
    activeCustomRange = null;

    // Synchronize UI
    document.querySelectorAll('.event-btn').forEach(b => b.classList.remove('active'));
    const todayBtn = document.getElementById('today-btn');
    if (todayBtn) todayBtn.classList.add('active');

    const fxSelect = document.getElementById('fx-event-select');
    if (fxSelect) fxSelect.value = 'snapshot';

    // Synchronize timeframe buttons to snapshot modes
    syncTimeframeButtons();

    // Redraw all affected panels
    updateMasterChart();
    if (activeBarometerTicker) {
        renderBarometerChart(activeBarometerTicker, activeBarometerTimeframe);
    }
    calculateSectorSnapshot();
    calculateImpactMetrics(null);
}

function handleEventSelection(idx) {
    if (idx == null || !macroEvents[idx]) return;
    const event = macroEvents[idx];

    // Activate authoritative shared event state
    sharedEventState.active = true;
    sharedEventState.eventIdx = idx;
    sharedEventState.eventId = event.name;
    sharedEventState.event = event;
    sharedEventState.archiveDate = event.date;
    // Default to 1M on first entry; preserve if user selected a horizon
    if (!sharedEventState.horizon) {
        sharedEventState.horizon = '1M';
    }

    activeEventMode = true;
    activeEventIdx = idx;
    activeEventHorizon = sharedEventState.horizon;
    activeCustomRange = null; // Clear obsolete fixed range

    // Synchronize UI on both tabs
    document.querySelectorAll('.event-btn').forEach((b, i) => b.classList.toggle('active', i === idx));
    const todayBtn = document.getElementById('today-btn');
    if (todayBtn) todayBtn.classList.remove('active');

    const fxSelect = document.getElementById('fx-event-select');
    if (fxSelect) fxSelect.value = String(idx);

    // Synchronize timeframe buttons across both tabs
    syncTimeframeButtons();

    // Redraw charts using the shared event horizon
    updateMasterChart();
    if (activeBarometerTicker) {
        renderBarometerChart(activeBarometerTicker, sharedEventState.horizon);
    }

    // Deferred panels: cancel any earlier pending render, then guard this one
    // with its own generation so stale work can't touch the current panels (D8).
    cancelPendingEventRender();
    const renderGen = eventRenderGeneration;
    pendingEventTimer = setTimeout(() => {
        pendingEventTimer = null;
        if (renderGen !== eventRenderGeneration || !sharedEventState.active) return;
        calculateImpactMetrics(event.date);
        calculateSectorBacktest(event.date);
    }, 50);
}

function handleFxEventSelectChange(val) {
    if (val === 'snapshot' || val === '' || val == null) {
        resetToToday();
    } else {
        const idx = parseInt(val, 10);
        if (!isNaN(idx) && macroEvents[idx]) {
            handleEventSelection(idx);
        }
    }
}

// Backtest helper shared by the sector rows and the Gold/WTI rows: the same
// validated view and baseline policy as sliceByEventHorizon. Returns
//   { skip:true }                      series has no observation before the event (row omitted)
//   { calc(offset), title }            calc gives formatted percent or 'N/A'; title explains N/A rows
function eventBacktestSeries(labels, prices, eventDateStr) {
    const na = (why) => ({ calc: () => 'N/A', title: `Unavailable: ${why}` });
    const view = buildEventSeriesView(labels, prices);
    if (!view.ok) return na(`series invalid (${view.reason})`);
    const sel = selectEventBaseline(view, eventDateStr);
    if (!sel.ok) {
        if (sel.code === 'no-pre-event') return { skip: true };
        return na(sel.short);
    }
    return {
        title: null,
        calc: (offset) => {
            const idx = sel.idx + offset;
            const r = computePriceReturn(sel.price, idx < view.length ? view.prices[idx] : undefined);
            return r.ok ? formatPct(r.pct) : 'N/A';
        },
        baselineDate: sel.date,
        baselineAgeDays: sel.ageDays
    };
}

// Price definition of the sector ETF series (Stage 2D3). The data are the provider's Close
// (requested with auto_adjust=False): distributions are NOT included, so these are price
// returns, not total returns. ETFs without history before an event are listed as unavailable.
const SECTOR_PRICE_DEFINITION_NOTE =
    "Sector ETF price returns use provider Close and exclude distributions. Data before each ETF's available history is unavailable.";
const SECTOR_PRICE_DEFINITION_DETAIL =
    'Series requested from the provider with auto_adjust=False (Close). Distributions are excluded; ' +
    'provider split/corporate-action treatment is not independently verified. ' +
    'The latest observation is provider-reported; completion of that session is not verified.';

function appendSectorPriceDefinitionNote(container, unavailable) {
    const note = document.createElement('div');
    note.className = 'sector-price-definition-note';
    note.style.cssText = 'padding:2px 10px 4px;font-size:0.6rem;color:#555;letter-spacing:0.3px;';
    note.title = SECTOR_PRICE_DEFINITION_DETAIL;
    note.textContent = SECTOR_PRICE_DEFINITION_NOTE;
    container.appendChild(note);
    if (Array.isArray(unavailable) && unavailable.length > 0) {
        const un = document.createElement('div');
        un.className = 'sector-unavailable-note';
        un.style.cssText = 'padding:2px 10px 4px;font-size:0.6rem;color:#555;letter-spacing:0.3px;';
        un.textContent = 'Unavailable for this event (no history before it): ' +
            unavailable.map(u => `${u.name} (data begins ${u.firstDate})`).join('; ') + '.';
        container.appendChild(un);
    }
}

function calculateSectorBacktest(targetDateStr) {
    const sectorContainer = document.getElementById('sector-flow-container');
    if (!sectorContainer) return;

    if (!sectorData || Object.keys(sectorData).length === 0) {
        sectorContainer.innerHTML = '<div style="padding:12px;color:#555;font-size:0.75rem;">Sector data unavailable.</div>';
        return;
    }

    sectorContainer.innerHTML = '';

    const header = document.createElement('div');
    header.style.cssText = 'padding:4px 10px;font-size:0.65rem;color:#555;letter-spacing:0.5px;';
    header.textContent = `RETROSPECTIVE PRICE IMPACT — Baseline: last close strictly before ${targetDateStr} (latest finite price, at most ${MAX_EVENT_BASELINE_AGE_DAYS} calendar days old)`;
    sectorContainer.appendChild(header);

    // The disclosure sits directly under the header; ETFs omitted because their series begins
    // after the event are collected here and named in a second muted line (display only).
    const noteAnchor = document.createElement('div');
    sectorContainer.appendChild(noteAnchor);
    const unavailable = [];

    Object.entries(SECTOR_MAP).forEach(([ticker, displayName]) => {
        const sectorRaw = sectorData[ticker];
        if (!Array.isArray(sectorRaw) || sectorRaw.length === 0) return;

        // Same validated view + baseline policy as the event charts and impact panel.
        const bt = eventBacktestSeries(sectorRaw.map(r => r && r.x), sectorRaw.map(r => r && r.y), targetDateStr);
        if (bt.skip) { // series begins after the event: no row (unchanged); named in the note below
            const firstView = buildEventSeriesView(sectorRaw.map(r => r && r.x), sectorRaw.map(r => r && r.y));
            unavailable.push({ name: ticker, firstDate: firstView.ok ? firstView.labels[0] : 'unknown' });
            return;
        }

        // Unusable series/baseline => every horizon of THIS sector is N/A (row kept, reason in tooltip).
        // Invalid endpoint => only that horizon is N/A. Other sectors are unaffected.
        const calc1D = bt.calc(1);
        const calc1W = bt.calc(5);
        const calc1M = bt.calc(22);
        const calc1Y = bt.calc(252);
        const row = document.createElement('div');
        row.className = 'metric-row';
        row.style.fontSize = '0.85rem';
        row.style.padding = '4px 10px';
        if (bt.title) row.title = bt.title;
        row.innerHTML = `
            <span class="metric-label" style="width:160px;flex-shrink:0;">${displayName}</span>
            <span style="width:75px;flex-shrink:0;">1D: ${calc1D}</span>
            <span style="width:75px;flex-shrink:0;">1W: ${calc1W}</span>
            <span style="width:75px;flex-shrink:0;">1M: ${calc1M}</span>
            <span style="width:85px;flex-shrink:0;">1Y: ${calc1Y}</span>
        `;
        sectorContainer.appendChild(row);
    });
    appendSectorPriceDefinitionNote(noteAnchor, unavailable);

    const separator = document.createElement('div');
    separator.style.cssText = 'border-top:1px solid #333;margin:8px 0;padding-top:8px;font-size:0.7rem;color:#444;padding-left:10px;letter-spacing:1px;';
    separator.textContent = 'COMMODITY PRICE IMPACT';
    sectorContainer.appendChild(separator);

    ['Gold', 'WTI Crude'].forEach(name => {
        const dataset = commodityData[name];
        if (!dataset || !Array.isArray(dataset.labels)) return;
        const bt = eventBacktestSeries(dataset.labels, dataset.prices, targetDateStr);
        if (bt.skip) return;
        const calcImpact = bt.calc;
        const row = document.createElement('div');
        row.className = 'metric-row';
        row.style.fontSize = '0.85rem';
        row.style.padding = '4px 10px';
        if (bt.title) row.title = bt.title;
        row.innerHTML = `
            <span class="metric-label" style="width:160px;flex-shrink:0;color:var(--amber);">${name.toUpperCase()}</span>
            <span style="width:75px;flex-shrink:0;">1D: ${calcImpact(1)}</span>
            <span style="width:75px;flex-shrink:0;">1W: ${calcImpact(5)}</span>
            <span style="width:75px;flex-shrink:0;">1M: ${calcImpact(22)}</span>
            <span style="width:85px;flex-shrink:0;">1Y: ${calcImpact(252)}</span>
        `;
        sectorContainer.appendChild(row);
    });
}

function formatPct(pct) {
    if (!isValidPrice(pct)) return 'N/A';
    const color = pct >= 0 ? 'var(--green)' : 'var(--red)';
    return `<span style="color:${color}">${pct.toFixed(2)}%</span>`;
}

// Latest-Snapshot trailing returns (1D/1W/1M/1Y = 1/5/22/252 observations before the
// LATEST observation; observation counts, not verified calendar periods).
// `values` is the chronological list of raw prices (last = latest). Each horizon goes
// through computePriceReturn(old, latest), so the rules are the ones used everywhere:
//   - missing/invalid (null, undefined, NaN, +/-Infinity, numeric string) latest or old price -> N/A
//   - zero or negative old price -> N/A (percentage needs a strictly positive baseline)
//   - a valid unchanged price is a real 0.00% return, distinct from N/A
//   - history shorter than the horizon -> N/A
// Returns four HTML strings; unavailable cells are "N/A" with the reason as a tooltip.
const SNAPSHOT_TRAILING_OFFSETS = [1, 5, 22, 252];
function snapshotTrailingCells(values, seriesProblem) {
    const na = (why) => `<span title="Unavailable: ${why}">N/A</span>`;
    if (!Array.isArray(values)) return SNAPSHOT_TRAILING_OFFSETS.map(() => na(seriesProblem || 'series malformed'));
    const latestIdx = values.length - 1;
    return SNAPSHOT_TRAILING_OFFSETS.map(offset => {
        const oldIdx = latestIdx - offset;
        if (oldIdx < 0) return na(`history shorter than ${offset} observation(s)`);
        const r = computePriceReturn(values[oldIdx], values[latestIdx]);
        return r.ok ? formatPct(r.pct) : na(r.reason);
    });
}

// Tooltip for a Latest Snapshot trailing-return row: the actual latest date and the actual
// comparison date behind each horizon (or why the series is unavailable). Sparse histories
// therefore show their real dates instead of implying calendar periods.
function snapshotRowTitle(view, problem) {
    if (!view || !view.ok) return `Unavailable: ${problem || `series invalid (${view && view.reason})`}`;
    const last = view.length - 1;
    const names = ['1D', '1W', '1M', '1Y'];
    const dates = SNAPSHOT_TRAILING_OFFSETS.map((o, i) => `${names[i]} ${last - o >= 0 ? view.labels[last - o] : 'n/a'}`);
    return `Latest observation ${view.labels[last]}. Compared with the observation 1/5/22/252 positions earlier (observation counts, not verified calendar periods): ${dates.join(', ')}.`;
}

function calculateSectorSnapshot() {
    const sectorContainer = document.getElementById('sector-flow-container');
    if (!sectorContainer) return;
    sectorContainer.innerHTML = '';

    if (!sectorData || Object.keys(sectorData).length === 0) {
        sectorContainer.innerHTML = '<div style="padding:12px;color:#555;font-size:0.75rem;">Sector data unavailable.</div>';
        return;
    }

    const header = document.createElement('div');
    header.style.cssText = 'padding:4px 10px;font-size:0.65rem;color:#555;letter-spacing:0.5px;';
    header.textContent = 'TRAILING PRICE RETURNS — from latest available observation';
    sectorContainer.appendChild(header);
    appendSectorPriceDefinitionNote(sectorContainer);

    Object.entries(SECTOR_MAP).forEach(([ticker, displayName]) => {
        const data = sectorData[ticker];
        if (data === undefined || data === null) return;
        if (Array.isArray(data) && data.length === 0) return;

        // Sector records are {x: date, y: price}. The series is validated (dates and prices
        // paired, sorted, duplicate/invalid dates rejected) with the same helper as every other
        // series. A malformed record or series is N/A for that row only; it never aborts the
        // panel. Prices are read without coercion.
        const rec = Array.isArray(data)
            ? { view: buildEventSeriesView(
                    data.map(r => (r !== null && typeof r === 'object' && r.x !== undefined) ? r.x : null), // missing date shows as null in the reason
                    data.map(r => (r !== null && typeof r === 'object') ? r.y : undefined)) }
            : { view: { ok: false, reason: null }, problem: 'series malformed (not a list of observations)' };
        const cells = rec.view.ok
            ? snapshotTrailingCells(rec.view.prices)
            : snapshotTrailingCells(null, rec.problem || `series invalid (${rec.view.reason})`);

        const row = document.createElement('div');
        row.className = 'metric-row';
        row.style.fontSize = '0.85rem';
        row.style.padding = '4px 10px';
        row.title = snapshotRowTitle(rec.view, rec.problem);
        row.innerHTML = `
            <span class="metric-label" style="width:160px;flex-shrink:0;">${displayName}</span>
            <span style="width:75px;flex-shrink:0;">1D: ${cells[0]}</span>
            <span style="width:75px;flex-shrink:0;">1W: ${cells[1]}</span>
            <span style="width:75px;flex-shrink:0;">1M: ${cells[2]}</span>
            <span style="width:85px;flex-shrink:0;">1Y: ${cells[3]}</span>
        `;
        sectorContainer.appendChild(row);
    });

    const separator = document.createElement('div');
    separator.style.cssText = 'border-top:1px solid #333;margin:8px 0;padding-top:8px;font-size:0.7rem;color:#444;padding-left:10px;letter-spacing:1px;';
    separator.textContent = 'COMMODITY PRICE METRICS';
    sectorContainer.appendChild(separator);

    ['Gold', 'WTI Crude'].forEach(name => {
        const dataset = commodityData[name];
        if (!dataset) return;
        const prices = dataset.prices;
        if (prices === undefined || prices === null) return;
        if (Array.isArray(prices) && prices.length === 0) return;
        const view = Array.isArray(prices)
            ? buildEventSeriesView(dataset.labels, prices)
            : { ok: false, reason: null };
        const problem = Array.isArray(prices) ? null : 'series malformed (prices is not a list)';
        const cells = view.ok
            ? snapshotTrailingCells(view.prices)
            : snapshotTrailingCells(null, problem || `series invalid (${view.reason})`);

        const row = document.createElement('div');
        row.className = 'metric-row';
        row.style.fontSize = '0.85rem';
        row.style.padding = '4px 10px';
        row.title = snapshotRowTitle(view, problem);
        row.innerHTML = `
            <span class="metric-label" style="width:160px;flex-shrink:0;color:var(--amber);">${name.toUpperCase()}</span>
            <span style="width:75px;flex-shrink:0;">1D: ${cells[0]}</span>
            <span style="width:75px;flex-shrink:0;">1W: ${cells[1]}</span>
            <span style="width:75px;flex-shrink:0;">1M: ${cells[2]}</span>
            <span style="width:85px;flex-shrink:0;">1Y: ${cells[3]}</span>
        `;
        sectorContainer.appendChild(row);
    });
}

function calculateImpactMetrics(targetDateStr) {
    const container = document.getElementById('impact-metrics-container');
    if (!container) return;
    container.innerHTML = '';

    if (!targetDateStr) {
        container.innerHTML = '<p class="placeholder" style="margin-top:20px;">LATEST SNAPSHOT ACTIVE.<br>SELECT HISTORICAL EVENT TO VIEW RETROSPECTIVE PRICE IMPACT.</p>';
        return;
    }

    if (Object.keys(commodityData).length === 0) {
        container.innerHTML = '<p class="placeholder" style="margin-top:20px;">Commodity data unavailable — cannot compute impact.</p>';
        return;
    }

    const event = sharedEventState.event || macroEvents.find(e => e.date === targetDateStr) || { name: 'Macro Event', date: targetDateStr };
    const horizon = sharedEventState.horizon || '1M';
    const hLabel = eventHorizonLabel(horizon);

    const results = [];
    const excluded = []; // series without a usable baseline or percentage basis: { name, reason }

    Object.entries(commodityData).forEach(([name, dataset]) => {
        if (!dataset || !Array.isArray(dataset.labels) || !Array.isArray(dataset.prices)) return;
        // One slicer call = one validated series view + one baseline policy (shared with the charts)
        const sliced = sliceByEventHorizon(dataset.labels, dataset.prices, targetDateStr, horizon);
        if (sliced.noData) {
            excluded.push({ name, reason: sliced.shortReason || 'no usable baseline' });
            return;
        }
        if (!sliced.returnsAvailable) {
            excluded.push({ name, reason: `percentage returns unavailable: baseline ${sliced.baselinePrice} on ${sliced.baselineDate} is not strictly positive` });
            return;
        }

        const view = sliced.view;
        const bIdx = sliced.baselineRawIdx;
        const bPrice = sliced.baselinePrice;
        const bDate = sliced.baselineDate;

        const getReturnAtOffset = (offset) => {
            const targetIdx = bIdx + offset;
            if (targetIdx >= view.length) {
                return { date: null, price: null, pct: null, available: false, reason: 'history ends earlier' };
            }
            // Price return = (endpoint price / baseline price) - 1, finite prices only
            const r = computePriceReturn(bPrice, view.prices[targetIdx]);
            if (!r.ok) {
                return { date: null, price: null, pct: null, available: false, reason: r.reason };
            }
            return { date: view.labels[targetIdx], price: view.prices[targetIdx], pct: r.pct, available: true };
        };

        const ret1D = getReturnAtOffset(1);
        const ret1W = getReturnAtOffset(5);
        const ret1M = getReturnAtOffset(22);
        const ret1Y = getReturnAtOffset(252);

        // Active horizon endpoint. Status (coverage is separate from return validity):
        //   'ok'         horizon completed/covered and the endpoint supports a return
        //   'incomplete' some forward history but the requested horizon/boundary is not reached
        //   'unverified' event-year end: series ends within 7 days of Dec 31, final session unconfirmed
        //   'noforward'  no observation after the baseline
        //   'invalid'    coverage established but the endpoint price is missing/invalid/stale
        let status;
        let horizonPct = null;
        let statusReason = null;
        if (sliced.horizonStatus === 'incomplete') status = 'incomplete';
        else if (sliced.horizonStatus === 'unverified') status = 'unverified';
        else if (sliced.horizonStatus === 'noforward') status = 'noforward';
        else if (!sliced.endpointUsable) {
            status = 'invalid';
            statusReason = sliced.endpointReason || 'endpoint unusable';
        } else {
            const hr = computePriceReturn(bPrice, sliced.endpointPrice);
            if (hr.ok) {
                status = 'ok';
                horizonPct = hr.pct;
            } else {
                status = 'invalid';
                statusReason = hr.reason;
            }
        }

        results.push({
            name,
            baselineDate: bDate,
            baselinePrice: bPrice,
            baselineAgeDays: sliced.baselineAgeDays,
            baselineSkipped: sliced.baselineSkipped,
            firstSessionDate: sliced.firstSessionDate,
            endDate: sliced.endDate,
            endpointDate: sliced.endpointDate,
            endPrice: sliced.endpointPrice,
            horizonPct,
            status,
            statusReason,
            ret1D,
            ret1W,
            ret1M,
            ret1Y,
            horizonComplete: sliced.horizonComplete,
            actualPostEventObs: sliced.actualPostEventObs,
            requestedObs: sliced.requestedObs,
            incompleteReason: sliced.incompleteReason
        });
    });

    const excludedList = excluded.map(e => `${e.name} (${e.reason})`).join(', ');

    if (results.length === 0) {
        container.innerHTML = `<p class="placeholder" style="margin-top:20px;">No commodity series had valid pre-event data for ${targetDateStr}.${excludedList ? `<br><span style="font-size:0.6rem;">Excluded: ${excludedList}.</span>` : ''}</p>`;
        return;
    }

    // Only instruments with a valid, completed horizon return are ranked.
    const eligible = results.filter(r => r.status === 'ok');
    eligible.sort((a, b) => b.horizonPct - a.horizonPct);
    const winner = eligible.length >= 1 ? eligible[0] : null;
    const loser = eligible.length >= 2 ? eligible[eligible.length - 1] : null;

    const renderBox = (data, type) => {
        const label = type === 'winner' ? 'TOP PERFORMER' : 'WORST PERFORMER';
        if (!data) {
            const why = eligible.length === 0
                ? `No instrument has a completed ${hLabel} horizon with valid prices`
                : `Needs at least 2 instruments with a completed ${hLabel} horizon`;
            return `
            <div class="wl-box ${type}">
                <span class="wl-label">${label}</span>
                <span class="wl-name" style="color:#777">N/A</span>
                <span class="wl-stats">${hLabel} return unavailable</span>
                <span style="font-size:0.58rem;color:#666;font-family:'Roboto Mono';margin-top:2px;">${why}</span>
            </div>
        `;
        }
        const sign = data.horizonPct >= 0 ? '+' : '';
        const color = data.horizonPct >= 0 ? 'var(--green)' : 'var(--red)';
        return `
            <div class="wl-box ${type}">
                <span class="wl-label">${label}</span>
                <span class="wl-name" style="color:${color}">${data.name.toUpperCase()}</span>
                <span class="wl-stats">${horizon === 'YTD' ? 'EVENT-YEAR END' : horizon} RETURN: ${sign}${data.horizonPct.toFixed(2)}%</span>
                <span style="font-size:0.58rem;color:#666;font-family:'Roboto Mono';margin-top:2px;">
                    ${fmtUsd(data.baselinePrice)} (${data.baselineDate}) → ${fmtUsd(data.endPrice)} (${data.endpointDate})
                </span>
            </div>
        `;
    };

    const dateRange = (r) => `<span style="display:block;color:#666;font-size:0.55rem;"> ${r.baselineDate} → ${r.endpointDate || r.endDate || 'N/A'}</span>`;

    // Horizon-status cell: a completed return is a number; everything else says why not.
    const fmtHorizonStatus = (r) => {
        if (r.status === 'ok') {
            const sign = r.horizonPct >= 0 ? '+' : '';
            const color = r.horizonPct >= 0 ? 'var(--green)' : 'var(--red)';
            return `<span style="color:${color};">${sign}${r.horizonPct.toFixed(2)}%</span>${dateRange(r)}`;
        }
        if (r.status === 'incomplete') {
            const detail = horizon === 'YTD'
                ? `data ends ${r.endDate || 'N/A'}`
                : `${r.actualPostEventObs}${typeof r.requestedObs === 'number' ? '/' + r.requestedObs : ''} obs to ${r.endDate || 'N/A'}`;
            return `<span style="color:var(--amber);" title="Not ranked: ${r.incompleteReason || 'requested horizon not reached'}">INCOMPLETE (${detail})</span>`;
        }
        if (r.status === 'unverified') {
            return `<span style="color:var(--amber);" title="Not ranked: ${r.incompleteReason}">YEAR-END UNVERIFIED (data ends ${r.endDate || 'N/A'})</span>`;
        }
        if (r.status === 'noforward') {
            return `<span style="color:var(--amber);" title="Not ranked: no observations after the baseline">NO FORWARD DATA</span>`;
        }
        return `<span style="color:#555;" title="Not ranked">N/A (${r.statusReason})</span>`;
    };

    // Build auditable breakdown table
    const tableRows = results.map(r => {
        const fmtRet = (retObj, label) => {
            if (!retObj.available) {
                return `<span style="color:#555;" title="${label} unavailable (${retObj.reason})">N/A</span>`;
            }
            const sign = retObj.pct >= 0 ? '+' : '';
            const color = retObj.pct >= 0 ? 'var(--green)' : 'var(--red)';
            const tip = `${label}: ${retObj.date} @ ${fmtUsd(retObj.price)} (Baseline: ${r.baselineDate} @ ${fmtUsd(r.baselinePrice)})`;
            return `<span style="color:${color};cursor:help;" title="${tip}">${sign}${retObj.pct.toFixed(2)}%</span>`;
        };
        const baseTip = `Baseline ${r.baselineDate}: ${r.baselineAgeDays} day(s) before the event` +
            (r.baselineSkipped > 0 ? `; ${r.baselineSkipped} invalid record(s) searched past` : '');

        return `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.03);font-size:0.68rem;font-family:'Roboto Mono';">
                <td style="padding:4px 6px;color:#ccc;font-weight:bold;">${r.name}</td>
                <td style="padding:4px 6px;color:#888;" title="${baseTip}">${fmtUsd(r.baselinePrice)}</td>
                <td style="padding:4px 6px;">${fmtRet(r.ret1D, '1D (T+1)')}</td>
                <td style="padding:4px 6px;">${fmtRet(r.ret1W, '1W (T+5)')}</td>
                <td style="padding:4px 6px;">${fmtRet(r.ret1M, '1M (T+22)')}</td>
                <td style="padding:4px 6px;">${fmtRet(r.ret1Y, '1Y (T+252)')}</td>
                <td style="padding:4px 6px;">${fmtHorizonStatus(r)}</td>
            </tr>
        `;
    }).join('');

    // Ranking disclosure: which instruments were ranked and which were left out.
    const notRanked = results.filter(r => r.status !== 'ok');
    const why = (r) => r.status === 'incomplete' ? 'incomplete horizon'
        : r.status === 'unverified' ? 'year-end coverage unverified'
        : r.status === 'noforward' ? 'no forward data'
        : 'endpoint ' + r.statusReason;
    let rankingNote = '';
    if (eligible.length === 0) {
        rankingNote = `Ranking unavailable: no instrument has a completed ${hLabel} horizon with valid prices.`;
    } else if (notRanked.length > 0 || eligible.length < 2) {
        rankingNote = `Ranking covers ${eligible.length} of ${results.length} instruments with a completed ${hLabel} horizon (eligible instruments only).`;
    }
    if (notRanked.length > 0) {
        rankingNote += ` Not ranked: ${notRanked.map(r => `${r.name} (${why(r)})`).join(', ')}.`;
    }
    if (excluded.length > 0) {
        rankingNote += ` Excluded (no usable baseline): ${excludedList}.`;
    }
    if (horizon === 'YTD') {
        rankingNote += ' Event-year end = December 31 of the event year; even "covered" does not verify every trading session.';
    }
    const rankingHtml = rankingNote
        ? `<div style="color:var(--amber);font-size:0.6rem;line-height:1.3;margin-bottom:6px;" data-role="ranking-note">${rankingNote.trim()}</div>`
        : '';

    const dateStatusBadge = event.date_status
        ? `<span style="font-size:0.58rem;padding:1px 4px;background:rgba(255,184,0,0.15);color:var(--amber);border:1px solid rgba(255,184,0,0.3);border-radius:2px;margin-left:4px;">${event.date_status.toUpperCase()}</span>`
        : '';

    const firstSess = sharedEventState.firstSessionDate ? ` · First session: <code>${sharedEventState.firstSessionDate}</code>` : '';

    // Baseline line: one date when every listed instrument agrees, otherwise say it varies.
    const baselineDates = Array.from(new Set(results.map(r => r.baselineDate)));
    const baselineLine = baselineDates.length === 1
        ? `<code>${baselineDates[0]}</code> (latest finite price strictly before event; ${results[0].baselineAgeDays} day(s) before event)`
        : `<code>varies by instrument</code> (see BASE tooltips and horizon column dates)`;

    container.innerHTML = `
        <div class="wl-container" style="margin-bottom:10px;">
            ${renderBox(winner, 'winner')}
            ${renderBox(loser, 'loser')}
        </div>
        <div style="background:#080808;border:1px solid var(--border);border-radius:4px;padding:8px;margin-top:6px;font-size:0.65rem;font-family:var(--font);">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;border-bottom:1px solid #1a1a1a;padding-bottom:4px;">
                <span style="color:var(--amber);font-weight:bold;">EVENT AUDIT &amp; RETURN BREAKDOWN</span>
                <span style="color:#666;font-size:0.58rem;">Horizon: <strong>${hLabel}</strong></span>
            </div>
            <div style="color:#aaa;line-height:1.4;margin-bottom:6px;font-size:0.62rem;">
                <strong>${event.name}</strong> · Archive: <code>${event.date}</code>${dateStatusBadge}<br>
                Baseline: ${baselineLine}${firstSess}<br>
                Window End: <code>${sharedEventState.endDate || 'N/A'}</code> · Status: <span style="color:${sharedEventState.isComplete ? 'var(--green)' : 'var(--amber)'};">${sharedEventState.isComplete ? 'Complete' : 'Incomplete'}</span>
            </div>
            ${rankingHtml}
            <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;text-align:left;">
                    <thead>
                        <tr style="color:#555;font-size:0.6rem;border-bottom:1px solid #222;">
                            <th style="padding:2px 6px;">ASSET</th>
                            <th style="padding:2px 6px;">BASE ($)</th>
                            <th style="padding:2px 6px;">1D (T+1)</th>
                            <th style="padding:2px 6px;">1W (T+5)</th>
                            <th style="padding:2px 6px;">1M (T+22)</th>
                            <th style="padding:2px 6px;">1Y (T+252)</th>
                            <th style="padding:2px 6px;">${hLabel} HORIZON</th>
                        </tr>
                    </thead>
                    <tbody>${tableRows}</tbody>
                </table>
            </div>
            <div style="color:#555;font-size:0.55rem;line-height:1.3;margin-top:6px;font-style:italic;">
                Formula: return = (P_endpoint / P_baseline) - 1, defined only for a strictly positive baseline. Baseline = latest finite price strictly before the archive event date, at most ${MAX_EVENT_BASELINE_AGE_DAYS} calendar days old (provisional quality threshold; it does not verify exchange sessions). 1W/1M/3M/6M/1Y/5Y are fixed observation counts (5/22/63/126/252/1260) over the records present, not verified calendar periods; sparse data can span longer. Hover percentages to inspect pricing dates and levels. Intraday event timestamps unavailable.
            </div>
        </div>
    `;
}
// ============================================================
// 7. TAB NAVIGATION
// ============================================================
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    const indexMap = { kutun: 0, macro: 1, equity: 2, valuation: 3, fx: 4, digital: 5, portfolio: 6 };
    document.querySelectorAll('.nav-item')[indexMap[tabId]]?.classList.add('active');

    // Keep button states synchronized when navigating tabs
    syncTimeframeButtons();

    if (tabId === 'equity' && !activeEquityTicker && equityData['RY.TO']) {
        selectEquityTicker('RY.TO');
    }
}


// ============================================================
// 8. EQUITY TERMINAL
// ============================================================
let activeEquityRegion = 'ALL';
let activeEquitySector = 'ALL';

function setEquityRegion(region) {
    activeEquityRegion = region;
    ['all', 'us', 'can'].forEach(r => {
        const btn = document.getElementById(`filter-region-${r}`);
        if (btn) btn.classList.remove('active');
    });
    const activeBtn = document.getElementById(`filter-region-${region.toLowerCase()}`);
    if (activeBtn) activeBtn.classList.add('active');
    renderEquityWatchlist();
}

function setEquitySector(sector) {
    activeEquitySector = sector;
    renderEquityWatchlist();
}

function buildEquityWatchlist() {
    const sectorSelect = document.getElementById('filter-sector');
    if (sectorSelect) {
        const sectors = new Set();
        if (equityData && typeof equityData === 'object' && !Array.isArray(equityData)) {
            Object.values(equityData).forEach(data => {
                if (data && typeof data === 'object' && !Array.isArray(data) && data.metadata?.sector && data.metadata.sector !== 'N/A') {
                    sectors.add(data.metadata.sector);
                }
            });
        }
        sectorSelect.innerHTML = '<option value="ALL">All Sectors</option>';
        Array.from(sectors).sort().forEach(sec => {
            const opt = document.createElement('option');
            opt.value = sec; opt.textContent = sec;
            sectorSelect.appendChild(opt);
        });
    }
    renderEquityWatchlist();
}

function renderEquityWatchlist() {
    const container = document.getElementById('equity-watchlist');
    if (!container) return;
    container.innerHTML = '';

    if (!equityData || typeof equityData !== 'object' || Array.isArray(equityData) || Object.keys(equityData).length === 0) {
        container.innerHTML = '<div style="padding:20px;color:#555;font-size:0.75rem;">Equity data invalid or unavailable.</div>';
        return;
    }

    let filteredTickers = Object.keys(equityData).filter(symbol => {
        const data = equityData[symbol];
        if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
        const isCan = symbol.endsWith('.TO');
        if (activeEquityRegion === 'US'  && isCan)  return false;
        if (activeEquityRegion === 'CAN' && !isCan) return false;
        if (activeEquitySector !== 'ALL' && data.metadata?.sector !== activeEquitySector) return false;
        return true;
    });

    if (filteredTickers.length === 0) {
        const hasAnyValid = Object.values(equityData).some(d => d && typeof d === 'object' && !Array.isArray(d));
        if (!hasAnyValid) {
            container.innerHTML = '<div style="padding:20px;color:#555;font-size:0.75rem;">Equity data invalid or unavailable.</div>';
        } else {
            container.innerHTML = '<div style="padding:20px;color:#666;text-align:center;">No tickers match criteria.</div>';
        }
        return;
    }

    filteredTickers.forEach(symbol => {
        const data = equityData[symbol];
        const row = document.createElement('div');
        row.className = 'watchlist-item';
        if (symbol === activeEquityTicker) row.classList.add('active');
        row.id = `watchlist-${symbol.replace('.', '-')}`;
        row.onclick = () => selectEquityTicker(symbol);
        row.innerHTML = `
            <span class="watchlist-ticker">${symbol}</span>
            <span class="watchlist-name">${(data && typeof data === 'object' && data.metadata?.longName) || symbol}</span>
        `;
        container.appendChild(row);
    });

    if (activeEquityTicker && !filteredTickers.includes(activeEquityTicker)) {
        selectEquityTicker(filteredTickers[0]);
    } else if (!activeEquityTicker && filteredTickers.length > 0) {
        selectEquityTicker(filteredTickers[0]);
    }
}

function selectEquityTicker(symbol) {
    activeEquityTicker = symbol;
    const data = (equityData && typeof equityData === 'object' && !Array.isArray(equityData)) ? equityData[symbol] : null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        const wrap = document.getElementById('equity-canvas-wrap');
        const canvas = document.getElementById('equity-canvas');
        if (equityChart) { equityChart.destroy(); equityChart = null; }
        showChartMessage(wrap, canvas, `No valid equity data for ${symbol || 'selected ticker'}`);
        return;
    }

    document.querySelectorAll('.watchlist-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`watchlist-${symbol.replace('.', '-')}`)?.classList.add('active');

    const tickerEl = document.getElementById('equity-main-ticker');
    const nameEl   = document.getElementById('equity-main-name');
    const summaryEl= document.getElementById('equity-summary');

    if (tickerEl)  tickerEl.textContent = symbol;
    if (nameEl)    nameEl.textContent   = data.metadata?.longName || symbol;
    if (summaryEl) summaryEl.textContent = data.metadata?.longBusinessSummary || 'No summary available.';

    const format = (val, prefix = '$') => (val === 'N/A' || val == null) ? 'N/A' : `${prefix}${val.toLocaleString()}`;

    const priceEl  = document.getElementById('stat-price');
    const mcapEl   = document.getElementById('stat-mcap');
    const peEl     = document.getElementById('stat-pe');
    const sectorEl = document.getElementById('stat-sector');
    const h52El    = document.getElementById('stat-52h');
    const l52El    = document.getElementById('stat-52l');

    if (priceEl)  priceEl.textContent  = format(data.metadata?.currentPrice);
    if (mcapEl)   mcapEl.textContent   = data.metadata?.marketCap && data.metadata.marketCap !== 'N/A'
        ? '$' + (data.metadata.marketCap / 1e12).toFixed(2) + 'T' : 'N/A';
    if (peEl)     peEl.textContent     = data.metadata?.trailingPE ?? 'N/A';
    if (sectorEl) sectorEl.textContent = data.metadata?.sector || 'N/A';
    if (h52El)    h52El.textContent    = format(data.metadata?.fiftyTwoWeekHigh);
    if (l52El)    l52El.textContent    = format(data.metadata?.fiftyTwoWeekLow);

    renderEquityChart(symbol);
}

function renderEquityChart(symbol) {
    const data = (equityData && typeof equityData === 'object' && !Array.isArray(equityData)) ? equityData[symbol] : null;
    const wrap = document.getElementById('equity-canvas-wrap');
    const canvas = document.getElementById('equity-canvas');

    if (equityChart) { equityChart.destroy(); equityChart = null; }

    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.historical_prices || typeof data.historical_prices !== 'object' || Array.isArray(data.historical_prices)) {
        showChartMessage(wrap, canvas, `No price history available for ${symbol}`);
        return;
    }

    const labels = Object.keys(data.historical_prices);
    const prices = Object.values(data.historical_prices);

    if (labels.length === 0) {
        showChartMessage(wrap, canvas, `No price observations for ${symbol}`);
        return;
    }

    // Restore canvas if it was hidden
    if (canvas) canvas.style.display = '';
    const old = wrap ? wrap.querySelector('.chart-no-data-msg') : null;
    if (old) old.remove();

    const ctx = canvas.getContext('2d');
    equityChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Price (snapshot)',
                data: prices,
                borderColor: '#00ff00',
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0,
                fill: true,
                backgroundColor: 'rgba(0,255,0,0.05)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index', intersect: false,
                    callbacks: { label: ctx => `Price: $${ctx.parsed.y.toFixed(2)}` }
                }
            },
            scales: {
                x: { ticks: { color: '#666', maxTicksLimit: 12, font: { family: 'Roboto Mono', size: 10 } }, grid: { color: '#1a1a1a' } },
                y: { ticks: { color: '#666', font: { family: 'Roboto Mono', size: 10 } }, grid: { color: '#1a1a1a' } }
            }
        }
    });
}

// ============================================================
// BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', initTerminal);
