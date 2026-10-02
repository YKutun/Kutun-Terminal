// ============================================================
// tests/test_data_status.js
// Stage 1A — Unit tests for data-status logic and chart slicing
//
// Run with:   node tests/test_data_status.js
// Requires:   Node.js
//
// This test file dynamically loads the production app.js file 
// to exercise the actual production functions without duplication.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 1. Load app.js
const appJsPath = path.join(__dirname, '..', 'app.js');
let appJsCode;
try {
    appJsCode = fs.readFileSync(appJsPath, 'utf8');
} catch (err) {
    console.error(`Failed to read app.js from ${appJsPath}`);
    process.exit(1);
}

// 2. Create a flexible mock environment for app.js
const mockElements = {};

function createMockElement(id, tagName = 'DIV') {
    const el = {
        id: id || '',
        tagName: tagName.toUpperCase(),
        innerHTML: '',
        textContent: '',
        value: '',
        checked: false,
        style: {},
        children: [],
        appendChild: function(child) {
            this.children.push(child);
            return child;
        },
        removeChild: function(child) {
            this.children = this.children.filter(c => c !== child);
        },
        remove: function() {
            if (this.parentNode) {
                this.parentNode.removeChild(this);
            }
        },
        querySelector: function(sel) {
            return createMockElement('', 'DIV');
        },
        querySelectorAll: function(sel) {
            return [];
        },
        classList: {
            add: function(...cls) { this._set.add(...cls); },
            remove: function(...cls) { cls.forEach(c => this._set.delete(c)); },
            toggle: function(c, force) {
                if (force !== undefined) { force ? this._set.add(c) : this._set.delete(c); }
                else { this._set.has(c) ? this._set.delete(c) : this._set.add(c); }
            },
            contains: function(c) { return this._set.has(c); },
            _set: new Set()
        },
        getContext: function() { return {}; },
        setAttribute: function() {},
        getAttribute: function() { return null; },
        addEventListener: function() {},
        removeEventListener: function() {}
    };
    if (id) mockElements[id] = el;
    return el;
}

const sandbox = {
    document: {
        getElementById: (id) => {
            if (!mockElements[id]) {
                mockElements[id] = createMockElement(id);
            }
            return mockElements[id];
        },
        createElement: (tagName) => createMockElement('', tagName),
        querySelector: (sel) => createMockElement('', 'DIV'),
        querySelectorAll: (sel) => {
            if (sel.includes('.baro-tf-btn') || sel.includes('.master-tf-btn')) {
                const prefix = sel.includes('.baro-tf-btn') ? 'baro-tf-' : 'master-tf-';
                const timeframes = ['1W', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'MAX'];
                return timeframes.map(tf => {
                    const id = prefix + tf;
                    if (!mockElements[id]) mockElements[id] = createMockElement(id, 'BUTTON');
                    return mockElements[id];
                });
            }
            if (sel.includes('.event-btn')) {
                return (mockElements['event-list-container']?._children || []).filter(c => c.className === 'event-btn');
            }
            if (sel.includes('input:checked')) {
                return [];
            }
            return [];
        },
        addEventListener: () => {}
    },
    window: {
        addEventListener: () => {}
    },
    Chart: function() { return { destroy: () => {}, update: () => {} }; },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    console: {
        log: () => {}, 
        warn: () => {}, 
        error: () => {}
    },
    setTimeout: (fn) => { fn(); },
    setInterval: setInterval
};

vm.createContext(sandbox);

try {
    vm.runInContext(appJsCode, sandbox);
} catch (err) {
    console.error("Evaluation of app.js failed:", err);
    process.exit(1);
}

// 3. Extract the production functions to test from the sandbox
const {
    buildCommodityStatus,
    buildSectorStatus,
    buildNewsStatus,
    buildEquityStatus,
    assessFreshness,
    summariseDateCoverage,
    sliceByTimeframe,
    sliceByEventHorizon,
    handleEventSelection,
    resetToToday,
    handleFxEventSelectChange,
    setMasterTimeframe,
    setBarometerTimeframe,
    setSharedEventHorizon,
    syncTimeframeButtons,
    sharedEventState,
    initTerminal,
    fetchDataset
} = sandbox;

if (!buildCommodityStatus || !fetchDataset) {
    console.error("Failed to extract production functions from app.js.");
    process.exit(1);
}

// ── Test runner ───────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(description, condition) {
    if (condition) {
        console.log(`  ✓  ${description}`);
        passed++;
    } else {
        console.error(`  ✗  ${description}`);
        failed++;
        failures.push(description);
    }
}

function assertEqual(description, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
        console.error(`  ✗  ${description}`);
        console.error(`      expected: ${JSON.stringify(expected)}`);
        console.error(`      actual:   ${JSON.stringify(actual)}`);
        failed++;
        failures.push(description);
    } else {
        console.log(`  ✓  ${description}`);
        passed++;
    }
}

function section(name) {
    console.log(`\n── ${name} ──`);
}

// ── Fixtures ──────────────────────────────────────────────────

const VALID_COMMODITY = {
    Gold: {
        labels: ['2020-01-02', '2020-01-03', '2024-12-30', '2025-01-02'],
        prices: [1520.00, 1521.50, 2630.00, 2650.00]
    },
    'WTI Crude': {
        labels: ['2020-01-02', '2020-01-03', '2025-01-02'],
        prices: [60.00, 61.00, 75.00]
    }
};

const VALID_SECTOR = {
    XLK: [
        { x: '2010-01-04', y: 20.0 },
        { x: '2020-06-01', y: 80.0 },
        { x: '2026-03-13', y: 220.0 }
    ],
    XLE: [
        { x: '2012-01-03', y: 70.0 },
        { x: '2026-01-02', y: 95.0 }
    ]
};

const VALID_NEWS = [
    { headline: 'Fed Holds Rates', link: 'http://x.com', published_at: '2026-03-10T12:00:00Z' },
    { headline: 'Inflation Data Released', link: 'http://y.com', published_at: '2026-03-15T09:00:00Z' }
];

const VALID_EQUITY = {
    AAPL: {
        metadata: { longName: 'Apple Inc.', sector: 'Technology', currentPrice: 175.0 },
        historical_prices: { '2025-03-17': 170.0, '2026-03-14': 175.0 }
    },
    'RY.TO': {
        metadata: { longName: 'Royal Bank', sector: 'Financials', currentPrice: 140.0 },
        historical_prices: { '2025-06-01': 135.0, '2026-02-28': 140.0 }
    },
    BAD_ENTRY: 'error: failed to load'
};

const REF_DATE = new Date('2026-03-15T00:00:00Z');
const LABELS_SPANNING_5Y = [
    '2021-03-15', '2021-06-15', '2022-01-01', '2023-06-01', '2024-01-01',
    '2025-01-01', '2026-01-01', '2026-03-10'
];
const PRICES_SPANNING_5Y = [100, 105, 110, 115, 120, 125, 130, 132];

// ── Tests ─────────────────────────────────────────────────────

async function runTests() {
    section('buildCommodityStatus');
    {
        const s = buildCommodityStatus(VALID_COMMODITY);
        assert('valid: status is loaded',  s.status === 'loaded');
        assert('valid: count = 2',         s.count === 2);
        assertEqual('valid: Gold latest date', s.latestDates.Gold, '2025-01-02');
    }

    section('buildSectorStatus (mixed latest dates per instrument)');
    {
        const s = buildSectorStatus(VALID_SECTOR);
        assert('status is loaded',     s.status === 'loaded');
        assert('count = 2',            s.count === 2);
        assertEqual('XLK latest', s.latestDates.XLK, '2026-03-13');
        assert('different latest dates preserved', s.latestDates.XLK !== s.latestDates.XLE);
    }

    section('buildNewsStatus');
    {
        const s = buildNewsStatus(VALID_NEWS);
        assert('valid: status is loaded', s.status === 'loaded');
        assertEqual('valid: latest pub date', s.latestPubDate, '2026-03-15T09:00:00Z');
    }

    section('buildEquityStatus (error strings skipped, mixed dates)');
    {
        const s = buildEquityStatus(VALID_EQUITY);
        assert('count = 2 (BAD_ENTRY skipped)', s.count === 2);
        assertEqual('AAPL latest', s.latestDates.AAPL, '2026-03-14');
    }

    section('assessFreshness');
    {
        const f = assessFreshness('2020-01-01');
        assert('very old: stale = true', f.stale === true);
    }

    section('summariseDateCoverage');
    {
        const cov = summariseDateCoverage(
            { XLK: '2026-03-13', XLE: '2026-01-02' },
            { XLK: '2010-01-04', XLE: '2012-01-03' }
        );
        assert('different latest: shows range', cov.includes('(range)'));
    }

    section('sliceByTimeframe (exact value/date assertions)');
    {
        // 1W matches only last date
        const r1W = sliceByTimeframe(LABELS_SPANNING_5Y, PRICES_SPANNING_5Y, '1W', null, REF_DATE);
        assert('1W: noData = false', r1W.noData === false);
        assertEqual('1W: labels exact match', r1W.labels, ['2026-03-10']);
        assertEqual('1W: prices exact match', r1W.prices, [132]);
        assertEqual('1W: latestAvail match', r1W.latestAvailableDate, '2026-03-10');

        // YTD starts 2026-01-01
        const rYTD = sliceByTimeframe(LABELS_SPANNING_5Y, PRICES_SPANNING_5Y, 'YTD', null, REF_DATE);
        assertEqual('YTD: labels exact match', rYTD.labels, ['2026-01-01', '2026-03-10']);
        assertEqual('YTD: prices exact match', rYTD.prices, [130, 132]);

        // Range before history (falls outside)
        const crBefore = { start: new Date('2000-01-01'), end: new Date('2010-01-01') };
        const rBefore = sliceByTimeframe(LABELS_SPANNING_5Y, PRICES_SPANNING_5Y, 'MAX', crBefore, REF_DATE);
        assert('range before: noData = true', rBefore.noData === true);
        assertEqual('range before: labels empty', rBefore.labels, []);

        // Range after history (falls outside)
        const crAfter = { start: new Date('2030-01-01'), end: new Date('2031-01-01') };
        const rAfter = sliceByTimeframe(LABELS_SPANNING_5Y, PRICES_SPANNING_5Y, 'MAX', crAfter, REF_DATE);
        assert('range after: noData = true', rAfter.noData === true);
        assertEqual('range after: labels empty', rAfter.labels, []);

        // Reversed range (start > end)
        const crReversed = { start: new Date('2024-01-01'), end: new Date('2023-01-01') };
        const rReversed = sliceByTimeframe(LABELS_SPANNING_5Y, PRICES_SPANNING_5Y, 'MAX', crReversed, REF_DATE);
        assert('range reversed: noData = true', rReversed.noData === true);
        assertEqual('range reversed: labels empty', rReversed.labels, []);

        // Valid overlapping range
        const crValid = { start: new Date('2023-01-01'), end: new Date('2024-12-31') };
        const rValid = sliceByTimeframe(LABELS_SPANNING_5Y, PRICES_SPANNING_5Y, 'MAX', crValid, REF_DATE);
        assertEqual('valid range: labels exact', rValid.labels, ['2023-06-01', '2024-01-01']);
        assertEqual('valid range: prices exact', rValid.prices, [115, 120]);
    }

    section('fetchDataset cache policy and error states');
    {
        const fetchInit = vm.runInContext('DATASET_FETCH_INIT', sandbox);
        assert('DATASET_FETCH_INIT.cache is no-store', fetchInit && fetchInit.cache === 'no-store');
        const calls = [];
        sandbox.fetch = async (url, opts) => {
            calls.push({ url, cache: opts && opts.cache });
            return { ok: true, status: 200, json: async () => ({ Gold: { labels: ['2020-01-02'], prices: [1] } }) };
        };
        const ok = await fetchDataset('commodities_data.json');
        assert('successful fetch still returns { ok, data }', ok.ok === true && ok.data && ok.data.Gold);
        assert('fetch was called with cache: no-store', calls.length === 1 && calls[0].cache === 'no-store');

        sandbox.fetch = async () => ({ ok: false, status: 304 });
        const notMod = await fetchDataset('commodities_data.json');
        assert('HTTP 304 is not treated as success', notMod.ok === false && notMod.error === 'HTTP 304');

        sandbox.fetch = async () => ({ ok: false, status: 404 });
        const missing = await fetchDataset('commodities_data.json');
        assert('HTTP 404 error state preserved', missing.ok === false && missing.error === 'HTTP 404');

        sandbox.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } });
        const parseErr = await fetchDataset('commodities_data.json');
        assert('JSON parse error state preserved', parseErr.ok === false && parseErr.error === 'JSON parse error');

        sandbox.fetch = async () => { throw new Error('network down'); };
        const netErr = await fetchDataset('commodities_data.json');
        assert('network error state preserved', netErr.ok === false && netErr.error === 'network down');
    }

    section('Malformed data handling (Loading isolation & harness safety)');
    {
        // Override sandbox fetch to simulate malformed equity payload + failed news payload
        sandbox.fetch = async (url) => {
            if (url.includes('equity')) {
                // Mix of malformed equity entries (null, string, array) and valid equity
                return {
                    ok: true,
                    json: async () => ({
                        BAD_NULL: null,
                        BAD_STRING: "error",
                        BAD_ARRAY: [1, 2, 3],
                        AAPL: {
                            metadata: { longName: 'Apple Inc.', sector: 'Technology', currentPrice: 175.0 },
                            historical_prices: { '2026-03-14': 175.0 }
                        }
                    })
                };
            }
            if (url.includes('live_news')) {
                // Failed load
                return { ok: false, status: 500 };
            }
            if (url.includes('sector')) {
                return { ok: true, json: async () => (VALID_SECTOR) };
            }
            if (url.includes('commodities')) {
                return { ok: true, json: async () => (VALID_COMMODITY) };
            }
            if (url.includes('macro_events')) {
                return { ok: true, json: async () => ([]) };
            }
            return { ok: true, json: async () => ({}) };
        };

        let initThrew = false;
        let initError = null;
        try {
            await initTerminal();
        } catch (e) {
            initThrew = true;
            initError = e;
        }

        // a) malformed equities do not throw
        assert('initTerminal handles malformed equities without throwing', !initThrew);

        // d) harness reports clean failure if initTerminal throws (without secondary TypeError)
        const ds = vm.runInContext('datasetStatus', sandbox) || {};

        // b) valid unrelated datasets still load
        assert('unrelated dataset (sectors) loaded successfully despite news failure & malformed equity', ds.sectors && ds.sectors.status === 'loaded');
        assert('unrelated dataset (commodities) loaded successfully', ds.commodities && ds.commodities.status === 'loaded');
        assert('news dataset status correctly recorded as failed', ds.news && ds.news.status === 'failed');

        // c) invalid equity entries are not rendered
        const watchlistEl = mockElements['equity-watchlist'] || {};
        const renderedText = (watchlistEl.innerHTML || '') + (watchlistEl.children ? watchlistEl.children.map(c => c.innerHTML || c.textContent).join(' ') : '');
        assert('invalid equity symbol BAD_NULL is not rendered', !renderedText.includes('BAD_NULL'));
        assert('invalid equity symbol BAD_STRING is not rendered', !renderedText.includes('BAD_STRING'));
        assert('invalid equity symbol BAD_ARRAY is not rendered', !renderedText.includes('BAD_ARRAY'));
        assert('valid equity symbol AAPL is rendered', renderedText.includes('AAPL'));
    }

    // ── Summary ───────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
        console.error('\nFailed assertions:');
        failures.forEach(f => console.error(`  • ${f}`));
        process.exit(1);
    } else {
        console.log('All tests passed.');
        process.exit(0);
    }
}

runTests();
