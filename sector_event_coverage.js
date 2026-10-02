'use strict';
/*
 * sector_event_coverage.js - Stage 2D2 offline harness (read-only).
 *
 * Runs the REAL app.js in a stubbed vm sandbox (the app is never booted: no DOMContentLoaded
 * handler is called, no fetch is answered) and asks the production sector event-backtest
 * path what it would show for each archived event and each sector ETF, for each dataset
 * supplied. Datasets are read from the files named on the command line and held in memory;
 * nothing is written except the --out file.
 *
 * Production functions used (not reimplemented here):
 *   buildEventSeriesView, selectEventBaseline, computePriceReturn, eventBacktestSeries
 *   (the helper behind calculateSectorBacktest), SECTOR_MAP, MAX_EVENT_BASELINE_AGE_DAYS.
 * The harness only does index arithmetic to name the endpoint date (view.labels[baselineIdx + offset],
 * the same offset the application uses) and cross-checks the displayed percentage against
 * computePriceReturn. The known event-offset issue is neither repaired nor worked around.
 *
 * Usage:
 *   node sector_event_coverage.js --events macro_events.json --dataset production=sector_historical.json
 *        --dataset candidate=<staging>/sector_historical.json --out <staging>/event_coverage.json [--app app.js]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const OFFSETS = [1, 5, 22, 252];

function parseArgs(argv) {
    const o = { datasets: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--app') o.app = argv[++i];
        else if (a === '--events') o.events = argv[++i];
        else if (a === '--out') o.out = argv[++i];
        else if (a === '--dataset') {
            const v = argv[++i] || '';
            const k = v.indexOf('=');
            if (k < 1) throw new Error('--dataset needs label=path');
            o.datasets.push({ label: v.slice(0, k), file: v.slice(k + 1) });
        } else throw new Error('unknown argument: ' + a);
    }
    if (!o.events || !o.out || o.datasets.length === 0) {
        throw new Error('required: --events FILE --dataset label=FILE (one or more) --out FILE');
    }
    o.app = o.app || path.join(__dirname, 'app.js');
    return o;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase(); }

function loadProductionFunctions(appPath) {
    const code = fs.readFileSync(appPath, 'utf8');
    const noop = () => {};
    const stubEl = () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, appendChild: noop, addEventListener: noop, setAttribute: noop });
    const sandbox = {
        document: { addEventListener: noop, getElementById: () => null, createElement: stubEl, querySelector: () => null, querySelectorAll: () => [] },
        window: { addEventListener: noop },
        Chart: function Chart() {},
        console: { log: noop, warn: noop, error: noop },
        fetch: async () => ({ ok: false, status: 404 }),
        setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'app.js' });
    const need = ['buildEventSeriesView', 'selectEventBaseline', 'computePriceReturn', 'eventBacktestSeries'];
    for (const n of need) {
        if (typeof sandbox[n] !== 'function') throw new Error('production function not found in app.js: ' + n);
    }
    return {
        fns: sandbox,
        sectorMap: JSON.parse(JSON.stringify(vm.runInContext('SECTOR_MAP', sandbox))),
        maxAge: vm.runInContext('MAX_EVENT_BASELINE_AGE_DAYS', sandbox),
        sha: sha256(Buffer.from(code, 'utf8'))
    };
}

function pctFromHtml(html) {
    if (typeof html !== 'string') return null;
    const m = /(-?\d+(?:\.\d+)?)%/.exec(html);
    return m ? Number(m[1]) : null;
}

function evaluate(app, raw, eventDate) {
    const f = app.fns;
    const labels = raw.map(r => r && r.x);
    const prices = raw.map(r => r && r.y);
    const bt = f.eventBacktestSeries(labels, prices, eventDate);
    if (bt.skip) {
        return { row: 'omitted', reason: 'no observation strictly before the event (series begins on or after the event date)', baseline: null, horizons: null };
    }
    const view = f.buildEventSeriesView(labels, prices);
    if (!view.ok) {
        return { row: 'shown_all_NA', reason: bt.title, baseline: null, horizons: null };
    }
    const sel = f.selectEventBaseline(view, eventDate);
    if (!sel.ok) {
        return { row: 'shown_all_NA', reason: bt.title || sel.reason, baseline: { reason: sel.reason, code: sel.code }, horizons: null };
    }
    const baseline = { date: sel.date, price: sel.price, ageDays: sel.ageDays };
    const horizons = {};
    for (const off of OFFSETS) {
        const idx = sel.idx + off;
        const shown = bt.calc(off);                       // production display value
        const displayedPct = pctFromHtml(shown);
        if (idx >= view.length) {
            horizons['T+' + off] = { available: false, reason: `history ends earlier (${view.length - 1 - sel.idx} observation(s) after the baseline, ${off} needed)`, endpointDate: null, pct: null, displayed: shown === 'N/A' ? 'N/A' : shown };
            continue;
        }
        const r = f.computePriceReturn(sel.price, view.prices[idx]);
        if (!r.ok) {
            horizons['T+' + off] = { available: false, reason: r.reason, endpointDate: view.labels[idx], pct: null, displayed: shown };
            continue;
        }
        horizons['T+' + off] = {
            available: displayedPct !== null,
            endpointDate: view.labels[idx], endpointPrice: view.prices[idx], pct: r.pct,
            displayed: displayedPct === null ? 'N/A' : displayedPct.toFixed(2) + '%',
            consistent_with_display: displayedPct !== null && displayedPct.toFixed(2) === r.pct.toFixed(2)
        };
    }
    return { row: 'shown', reason: null, baseline, horizons };
}

function main() {
    const o = parseArgs(process.argv.slice(2));
    const app = loadProductionFunctions(o.app);
    const events = JSON.parse(fs.readFileSync(o.events, 'utf8'));
    const out = {
        harness: 'sector_event_coverage.js', app_js: o.app, app_js_sha256: app.sha, offsets: OFFSETS,
        max_event_baseline_age_days: app.maxAge, tickers: Object.keys(app.sectorMap),
        events: events.map(e => ({ name: e.name, date: e.date })), datasets: {}, rows: []
    };
    for (const ds of o.datasets) {
        const buf = fs.readFileSync(ds.file);
        out.datasets[ds.label] = { file: ds.file, sha256: sha256(buf) };
        const data = JSON.parse(buf.toString('utf8'));
        for (const ev of events) {
            for (const ticker of Object.keys(app.sectorMap)) {
                const raw = data[ticker];
                const base = { dataset: ds.label, event: ev.name, eventDate: ev.date, ticker };
                if (!Array.isArray(raw) || raw.length === 0) {
                    out.rows.push(Object.assign(base, { row: 'omitted', reason: 'ticker absent or empty in dataset (production skips it)', baseline: null, horizons: null }));
                    continue;
                }
                out.rows.push(Object.assign(base, evaluate(app, raw, ev.date)));
            }
        }
    }
    fs.writeFileSync(o.out, JSON.stringify(out, null, 1));
    console.log(`wrote ${o.out}: ${out.rows.length} rows (${events.length} events x ${out.tickers.length} tickers x ${o.datasets.length} dataset(s))`);
}

try { main(); } catch (e) { console.error('HARNESS FAILURE: ' + e.message); process.exit(2); }
