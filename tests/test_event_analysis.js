// ============================================================
// tests/test_event_analysis.js
// Stage 1B — Event-analysis tests that execute the REAL app.js
//
// Run with:   node tests/test_event_analysis.js
// Requires:   Node.js 18+ (app.js uses Array.prototype.findLastIndex;
//             this file uses structuredClone). No npm dependencies.
//
// HOW IT WORKS
//   * app.js is read as text and executed inside a fresh node:vm
//     context for every scenario. No production logic is copied here.
//   * The DOM is a minimal mock BUILT FROM THE REAL index.html
//     (element ids, initial classes, inline onclick/onchange text).
//     Inline handlers are executed inside the app context, so the
//     HTML -> app.js wiring is exercised.
//   * Chart is a recording mock. Tests inspect the chart config
//     (labels, datasets, spanGaps) that production code produced.
//   * Date is pinned (see DEFAULT_NOW) and setTimeout is queued, so
//     results are deterministic.
//
// WHAT THIS IS NOT
//   This is NOT visual browser verification. Mocks prove handler,
//   state and data-shaping logic only. Nothing here proves that a
//   real browser renders, styles or lays out anything correctly.
//
// PROVISIONAL BASELINE CONVENTION (recorded, not endorsed)
//   Archive event dates are date-only. The return baseline is the
//   last observation whose date is STRICTLY BEFORE the archive date.
//   Intraday event timestamps are not modelled. This is a provisional
//   convention, not a settled financial methodology; these tests
//   pin the CURRENT behaviour so that a later methodology change is
//   a deliberate, visible decision.
//
// DEFECT IDS
//   Assertions tagged [D1]..[D8] encode CORRECT behaviour that the
//   current app.js is suspected (from code reading) not to meet.
//   They are kept strict on purpose. A failure there is a
//   preserved regression, not a reason to loosen the assertion.
//   D1 non-finite prices accepted        D5 unsorted dates
//   D2 null endpoint => -100% return     D6 labels/prices length mismatch
//   D3 incomplete horizon shown as number D7 YTD "complete" with truncated year
//   D4 sector backtest null => -100%     D8 stale deferred panel after reset
//
// EXIT CODES: 0 all pass; 1 assertion failures; 2 harness/prereq failure.
//
// EXPECTATION CHANGES (D5/D6/D7 checkpoint). Each pinned a convention that the
// checkpoint requirements explicitly replaced; every site is marked "CHANGED":
//   sec 4   YTD title/panel label "YTD" -> "Event-year end" in event mode        (requirement D)
//   sec 7   YTD for a 1 Jan event: complete=true -> incomplete (data ends 2020-01-02) (requirement D)
//   sec 8   event 2023-10-20 (10 days after data) -> 2023-10-13; too-old case asserted separately (requirement B)
//   sec 9   invalid nearest baseline: noData -> search past it (<= 7 days), 6 value variants (requirement B)
//   sec 11/14c  "Beyond Data" event 2030-01-01 -> 2015-01-23 so a baseline still exists (requirement B)
//   sec 14b baseline-variant and sector-baseline assertions: excluded/N-A -> earlier baseline used (requirement B)
//
// SNAPSHOT-CALCULATION CHECKPOINT: no existing expectation was changed or weakened. Sections 16a-16f were
// added (Latest Snapshot numeric validity, unavailable states, rolling controls, event -> snapshot transitions).
//
// SNAPSHOT DATE-AND-GAP CHECKPOINT: one expectation changed (section 16e): the rolling-window boundary allowance that accepted the\n// cutoff date OR the next weekday (time-zone dependent) was replaced by the single exact cutoff date (windows are anchored to\n// today's UTC date and include the cutoff date). Sections 17a-17j added (incl. a child-process time-zone matrix). No other\n// assertion was edited or weakened.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

if (typeof [].findLastIndex !== 'function' || typeof structuredClone !== 'function') {
    console.error('HARNESS PREREQUISITE NOT MET: Node.js 18 or later is required ' +
        '(Array.prototype.findLastIndex and structuredClone).');
    process.exit(2);
}

const APP_JS_PATH = path.join(__dirname, '..', 'app.js');
const INDEX_HTML_PATH = path.join(__dirname, '..', 'index.html');
let appJsCode;
let indexHtml;
try {
    appJsCode = fs.readFileSync(APP_JS_PATH, 'utf8');
    indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
} catch (err) {
    console.error(`HARNESS FAILURE: cannot read app.js / index.html: ${err.message}`);
    process.exit(2);
}

// ── Assertion runner ─────────────────────────────────────────
let passed = 0;
let failed = 0;
let currentSection = '';
const failures = [];

function check(description, condition, defectId) {
    const tag = defectId ? `[${defectId}] ` : '';
    if (condition) {
        console.log(`  ✓  ${tag}${description}`);
        passed++;
        return true;
    }
    console.error(`  ✗  ${tag}${description}`);
    failed++;
    failures.push({ section: currentSection, description, defectId: defectId || null });
    return false;
}

function eq(description, actual, expected, defectId) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    const ok = check(description, a === e, defectId);
    if (!ok) {
        console.error(`      expected: ${e}`);
        console.error(`      actual:   ${a}`);
    }
    return ok;
}

// Set KUTUN_EVIDENCE=1 to print the actual values behind defect-tagged assertions.
function evidence(label, value) {
    if (process.env.KUTUN_EVIDENCE) console.log('  EVIDENCE ' + label + ': ' + (typeof value === 'string' ? value : JSON.stringify(value)));
}

const sections = [];
function section(name, fn) { sections.push({ name, fn }); }

// ── Mock DOM (built from the real index.html) ────────────────
class MockElement {
    constructor(tag, doc) {
        this.tagName = String(tag).toUpperCase();
        this._doc = doc;
        this.id = '';
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.textContent = '';
        this.value = '';
        this.onclick = null;
        this._html = '';
        this._classes = new Set();
        this._attrs = {};
        const self = this;
        this.classList = {
            add(...c) { c.forEach(x => self._classes.add(x)); },
            remove(...c) { c.forEach(x => self._classes.delete(x)); },
            toggle(c, force) {
                const want = force === undefined ? !self._classes.has(c) : !!force;
                if (want) self._classes.add(c); else self._classes.delete(c);
                return want;
            },
            contains(c) { return self._classes.has(c); }
        };
    }
    get className() { return Array.from(this._classes).join(' '); }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get innerHTML() { return this._html; }
    set innerHTML(v) {
        this._html = String(v);
        this.children.forEach(c => { c.parentNode = null; });
        this.children = [];
    }
    get nextSibling() {
        const p = this.parentNode;
        if (!p) return null;
        return p.children[p.children.indexOf(this) + 1] || null;
    }
    appendChild(c) {
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = this;
        this.children.push(c);
        return c;
    }
    removeChild(c) {
        this.children = this.children.filter(x => x !== c);
        c.parentNode = null;
        return c;
    }
    insertBefore(c, ref) {
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = this;
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
        return c;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    getContext() { return { canvasId: this.id }; }
    setAttribute(k, v) { this._attrs[k] = v; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
    addEventListener() {}
    removeEventListener() {}
    descendants() {
        const out = [];
        const walk = n => n.children.forEach(c => { out.push(c); walk(c); });
        walk(this);
        return out;
    }
    querySelectorAll(sel) { return selectFrom(this._doc, this, sel); }
    querySelector(sel) { return selectFrom(this._doc, this, sel)[0] || null; }
}

// Supported selectors are exactly those app.js event/chart code uses.
function selectFrom(doc, root, sel) {
    if (sel === '#master-checkboxes input:checked') {
        return doc.checked.map(v => ({ value: v, checked: true, tagName: 'INPUT' }));
    }
    const m = /^\.([\w-]+)$/.exec(sel);
    if (m) return root.descendants().filter(e => e._classes.has(m[1]));
    doc.unsupportedSelectors.push(sel);
    return [];
}

class MockDocument {
    constructor() {
        this.unsupportedSelectors = [];
        this.checked = ['Gold', 'WTI Crude']; // production default checkboxes
        this.listeners = {};
        this.body = new MockElement('body', this);
    }
    createElement(tag) { return new MockElement(tag, this); }
    getElementById(id) { return this.body.descendants().find(e => e.id === id) || null; }
    querySelectorAll(sel) { return selectFrom(this, this.body, sel); }
    querySelector(sel) { return selectFrom(this, this.body, sel)[0] || null; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
}

// Create one element per tag carrying an id in the real index.html.
function populateFromHtml(doc, html) {
    const tagRe = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    const attrRe = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
        const attrs = {};
        let a;
        attrRe.lastIndex = 0;
        while ((a = attrRe.exec(m[2])) !== null) attrs[a[1]] = a[2] !== undefined ? a[2] : a[3];
        if (!attrs.id) continue;
        const el = doc.createElement(m[1]);
        el.id = attrs.id;
        el.className = attrs.class || '';
        el._attrs = attrs;
        doc.body.appendChild(el);
    }
}

function textOf(el) {
    if (!el) return '';
    return [el._html, el.textContent].concat(el.children.map(textOf)).join(' ');
}

// ── App loader ───────────────────────────────────────────────
// Returns a fresh, booted app instance (real app.js in its own VM context).

function weekdays(startISO, n) {
    const out = [];
    const d = new Date(`${startISO}T00:00:00Z`);
    while (out.length < n) {
        const dow = d.getUTCDay();
        if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
}

// price = base + index, every weekday is a session (synthetic calendar, no holidays).
function linear(startISO, n, base) {
    const labels = weekdays(startISO, n);
    return { labels, prices: labels.map((_, i) => base + i) };
}

const LIN_N = 1300;
const LIN_GOLD = linear('2015-01-01', LIN_N, 100);
const LIN_WTI = linear('2015-01-01', LIN_N, 50);
const DEFAULT_NOW = `${LIN_GOLD.labels[LIN_N - 1]}T12:00:00Z`; // 2019-12-25

const EVENTS_MAIN = [
    { name: 'Linear Event',  date: '2015-01-05', description: 'Monday; data exists on the date' },
    { name: 'Weekend Event', date: '2015-03-07', description: 'Saturday; date-only archive event' },
    { name: 'Monday Event',  date: '2015-06-01', description: 'Monday' },
    { name: 'Pre-Data Event', date: '2001-01-01', description: 'Before any fixture observation' }
];

function sectorSeries(nullAt) {
    const dates = weekdays('2015-01-01', 30);
    return dates.map((x, i) => ({ x, y: (nullAt !== undefined && i === nullAt) ? null : 50 + i }));
}
const DEFAULT_SECTORS = { XLK: sectorSeries() };

const createdApps = []; // apps created by the current section; checked for unclaimed deferred errors

async function loadApp(opts = {}) {
    const fixtures = {
        'commodities_data.json': opts.commodities || { Gold: LIN_GOLD, 'WTI Crude': LIN_WTI },
        'macro_events.json': opts.events || EVENTS_MAIN,
        'sector_historical.json': opts.sectors || DEFAULT_SECTORS,
        'live_news.json': [],
        'equity_data.json': {}
    };
    const now = opts.now || DEFAULT_NOW;
    const nowMs = Date.parse(now);

    const doc = new MockDocument();
    populateFromHtml(doc, indexHtml);

    const chartLog = [];
    function Chart(ctx, config) {
        this.canvasId = ctx && ctx.canvasId;
        this.config = config;
        this.destroyed = false;
        chartLog.push(this);
    }
    Chart.prototype.destroy = function () { this.destroyed = true; };
    Chart.prototype.update = function () {};

    class FixedDate extends Date {
        constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
        static now() { return nowMs; }
    }

    const timers = [];
    let timerSeq = 0;
    const timerErrors = [];
    const fetchLog = [];
    const sandbox = {
        document: doc,
        window: { addEventListener() {} },
        Chart,
        Date: FixedDate,
        console: { log() {}, warn() {}, error() {} },
        fetch: async (url, opts) => {
            fetchLog.push({ url: String(url), cache: opts && opts.cache });
            const key = String(url);
            if (!Object.prototype.hasOwnProperty.call(fixtures, key)) return { ok: false, status: 404 };
            const data = structuredClone(fixtures[key]); // keeps Infinity/NaN/undefined for bad-data fixtures
            return { ok: true, status: 200, json: async () => data };
        },
        // Timers carry unique ids so clearTimeout really cancels. opts.ignoreClearTimeout
        // simulates a cancellation failure to prove the generation guard works on its own.
        setTimeout: (fn) => { const id = ++timerSeq; timers.push({ id, fn }); return id; },
        clearTimeout: (id) => {
            if (opts.ignoreClearTimeout) return;
            const i = timers.findIndex(t => t.id === id);
            if (i >= 0) timers.splice(i, 1);
        },
        setInterval() { return 0; }
    };
    vm.createContext(sandbox);
    vm.runInContext(appJsCode, sandbox, { filename: 'app.js' });

    const boot = doc.listeners.DOMContentLoaded || [];
    if (boot.length === 0) throw new Error('HARNESS: app.js did not register a DOMContentLoaded listener');
    await Promise.all(boot.map(fn => fn()));

    function runInline(el, code) {
        const fn = vm.runInContext(`(function(){ ${code}\n})`, sandbox);
        return fn.call(el);
    }

    const app = {
        ctx: sandbox,
        doc,
        now,
        run: code => vm.runInContext(code, sandbox),
        state: () => vm.runInContext('sharedEventState', sandbox),
        fn: name => sandbox[name],
        byId: id => doc.getElementById(id),
        all: sel => doc.querySelectorAll(sel),
        setChecked: names => { doc.checked = names.slice(); },
        // Run queued timer callbacks in order. Like a browser, an exception in one
        // callback aborts only that callback: it is recorded (not rethrown) and the
        // remaining callbacks still run. Unclaimed errors fail the section (see main()).
        flush() {
            let guard = 0;
            while (timers.length > 0 && guard++ < 100) {
                const fn = timers.shift().fn;
                try { fn(); } catch (e) { timerErrors.push(e); }
            }
        },
        takeTimerErrors: () => timerErrors.splice(0),
        pendingTimers: () => timers.length,
        charts: canvasId => chartLog.filter(c => c.canvasId === canvasId),
        liveChart(canvasId) {
            const live = chartLog.filter(c => c.canvasId === canvasId && !c.destroyed);
            return live.length ? live[live.length - 1] : null;
        },
        click(target) {
            const el = typeof target === 'string' ? doc.getElementById(target) : target;
            if (!el) throw new Error(`HARNESS: click target not found: ${target}`);
            if (typeof el.onclick === 'function') return el.onclick();
            if (el._attrs.onclick) return runInline(el, el._attrs.onclick);
            throw new Error(`HARNESS: element ${el.id || el.tagName} has no click handler`);
        },
        change(id, value) {
            const el = doc.getElementById(id);
            if (!el || !el._attrs.onchange) throw new Error(`HARNESS: no onchange handler on ${id}`);
            el.value = value;
            return runInline(el, el._attrs.onchange);
        },
        activeIds: cls => doc.querySelectorAll(`.${cls}`).filter(e => e._classes.has('active')).map(e => e.id),
        text: id => textOf(doc.getElementById(id)),
        panelHtml: () => doc.getElementById('impact-metrics-container')._html,
        fetchLog
    };
    createdApps.push(app);
    return app;
}

function mainApp(extra = {}) {
    return loadApp(Object.assign({ commodities: { Gold: LIN_GOLD, 'WTI Crude': LIN_WTI }, events: EVENTS_MAIN }, extra));
}

// ── Parsers for production-generated HTML ────────────────────
function stripTags(s) { return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }

// Audit table rows: { Gold: { base: '$101.00', cells: ['+0.99%',...], titles: [...] } }
function parseAudit(html) {
    const rows = {};
    html.split('<tr').slice(1).forEach(chunk => {
        const tds = Array.from(chunk.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)).map(m => m[1]);
        if (tds.length < 6) return;
        rows[stripTags(tds[0])] = {
            base: stripTags(tds[1]),
            cells: tds.slice(2, 6).map(stripTags),
            titles: tds.slice(2, 6).map(t => { const m = /title="([^"]*)"/.exec(t); return m ? m[1] : null; })
        };
    });
    return rows;
}

function parseBoxes(html) {
    const out = {};
    [['winner', 'TOP PERFORMER'], ['loser', 'WORST PERFORMER']].forEach(([key, label]) => {
        const m = new RegExp(`${label}</span>\\s*<span[^>]*>([^<]*)</span>\\s*<span class="wl-stats">([^<]*)</span>`).exec(html);
        out[key] = m ? { name: m[1].trim(), stats: m[2].trim() } : null;
    });
    return out;
}

function hasNumericHorizonReturn(stats, horizon) {
    return new RegExp(`${horizon} RETURN:\\s*[+-]?\\d`).test(stats || '');
}

function slice(labels, prices, eventDate, horizon, app) {
    // Always call the production function from a booted app context.
    return app.fn('sliceByEventHorizon')(labels, prices, eventDate, horizon);
}

// Shared assertion helper for the selection tests.
function assertSelected(app, idx, tag) {
    const s = app.state();
    const ev = EVENTS_MAIN[idx];
    check(`${tag}: sharedEventState.active`, s.active === true);
    eq(`${tag}: eventIdx`, s.eventIdx, idx);
    eq(`${tag}: eventId`, s.eventId, ev.name);
    eq(`${tag}: archiveDate`, s.archiveDate, ev.date);
    check(`${tag}: event object is the archive entry`, s.event && s.event.name === ev.name);
    eq(`${tag}: legacy activeEventMode`, app.run('activeEventMode'), true);
    eq(`${tag}: legacy activeEventIdx`, app.run('activeEventIdx'), idx);
    eq(`${tag}: event-btn active flags`,
        app.all('.event-btn').map(b => b._classes.has('active')),
        EVENTS_MAIN.map((_, i) => i === idx));
    eq(`${tag}: fx dropdown value`, app.byId('fx-event-select').value, String(idx));
    check(`${tag}: today-btn not active`, !app.byId('today-btn')._classes.has('active'));
}

// ============================================================
// SECTIONS
// ============================================================

section('Harness sanity (failure here = harness bug, exit 2)', async () => {
    const app = await mainApp();
    const h = [];
    h.push(['index.html supplies 8 baro + 8 master timeframe buttons',
        app.all('.baro-tf-btn').length === 8 && app.all('.master-tf-btn').length === 8]);
    h.push(['initial active buttons come from index.html (baro 1Y, master 5Y)',
        JSON.stringify(app.activeIds('baro-tf-btn')) === '["baro-tf-1Y"]' &&
        JSON.stringify(app.activeIds('master-tf-btn')) === '["master-tf-5Y"]']);
    h.push(['inline onclick text captured from index.html',
        (app.byId('master-tf-1Y')._attrs.onclick || '').includes("setMasterTimeframe('1Y')")]);
    h.push(['fx select inline onchange captured',
        (app.byId('fx-event-select')._attrs.onchange || '').includes('handleFxEventSelectChange')]);
    h.push(['Date is pinned inside the app context', app.run('new Date().toISOString()') === DEFAULT_NOW.replace('Z', '.000Z')]);
    h.push(['Date with arguments still works', app.run("new Date('2020-01-02').toISOString()") === '2020-01-02T00:00:00.000Z']);
    h.push(['datasetStatus.commodities loaded', app.run('datasetStatus.commodities.status') === 'loaded']);
    h.push(['datasetStatus.events loaded', app.run('datasetStatus.events.status') === 'loaded']);
    h.push(['master chart exists after boot', app.liveChart('master-canvas') !== null]);
    h.push(['barometer chart exists after boot', app.liveChart('barometer-canvas') !== null]);
    h.push(['DOM class toggle semantics', (() => {
        const e = app.byId('today-btn');
        e.classList.toggle('zz', true); const a = e.classList.contains('zz');
        e.classList.toggle('zz', false); const b = e.classList.contains('zz');
        return a === true && b === false;
    })()]);
    h.push(['fixture calendar: labels[253]', LIN_GOLD.labels[253] === '2015-12-22']);
    h.push(['fixture calendar: labels[1261]', LIN_GOLD.labels[1261] === '2019-11-01']);
    h.push(['fixture calendar: labels[1299]', LIN_GOLD.labels[1299] === '2019-12-25']);
    const bad = h.filter(([, ok]) => !ok);
    h.forEach(([d, ok]) => check(d, ok));
    if (bad.length > 0) {
        console.error('\nHARNESS FAILURE: mock environment is not trustworthy; aborting.');
        console.error(bad.map(([d]) => `  • ${d}`).join('\n'));
        process.exit(2);
    }
});

section('1. Shared selection from either tab', async () => {
    const app = await mainApp();
    const s0 = app.state();
    check('boots in Latest Snapshot mode', s0.active === false && s0.eventIdx === null);
    const btns = app.all('.event-btn');
    eq('main list: one button per archive event', btns.length, 4);
    eq('main list: first button text', btns[0].textContent, '2015-01-05 | Linear Event');
    eq('fx dropdown: one option per event (snapshot option is markup)',
        app.byId('fx-event-select').children.map(o => o.value), ['0', '1', '2', '3']);

    app.click(btns[2]);                          // main-tab list click
    app.flush();
    assertSelected(app, 2, 'main-tab click');

    app.change('fx-event-select', '0');          // FX-tab dropdown change
    app.flush();
    assertSelected(app, 0, 'fx dropdown change');

    app.change('fx-event-select', '1');
    app.click(btns[2]);
    app.flush();
    assertSelected(app, 2, 'fx then main');

    const fxSel = app.fn('handleFxEventSelectChange');
    ['abc', '99', 'none', '-1'].forEach(v => fxSel(v));
    app.fn('handleEventSelection')(99);
    app.fn('handleEventSelection')(null);
    app.flush();
    assertSelected(app, 2, 'invalid selections are ignored');

    app.change('fx-event-select', 'snapshot');
    const s = app.state();
    check('fx "snapshot" value exits event mode', s.active === false && s.eventIdx === null);
    eq('fx dropdown shows snapshot', app.byId('fx-event-select').value, 'snapshot');
});

section('2. Selecting another event preserves the chosen horizon', async () => {
    const app = await mainApp();
    eq('default horizon on first entry is 1M (before selection)', app.state().horizon, '1M');
    app.click(app.all('.event-btn')[0]);
    app.flush();
    eq('first entry: horizon 1M', app.state().horizon, '1M');
    eq('first entry: active buttons are 1M', [app.activeIds('baro-tf-btn'), app.activeIds('master-tf-btn')],
        [['baro-tf-1M'], ['master-tf-1M']]);

    app.click('master-tf-1Y');
    eq('horizon set to 1Y from FX tab buttons', app.state().horizon, '1Y');

    app.change('fx-event-select', '2');
    app.flush();
    eq('after fx-dropdown event change horizon still 1Y', app.state().horizon, '1Y');
    eq('legacy activeEventHorizon still 1Y', app.run('activeEventHorizon'), '1Y');

    app.click(app.all('.event-btn')[1]);
    app.flush();
    eq('after main-list event change horizon still 1Y', app.state().horizon, '1Y');
    eq('buttons on both tabs still show 1Y', [app.activeIds('baro-tf-btn'), app.activeIds('master-tf-btn')],
        [['baro-tf-1Y'], ['master-tf-1Y']]);

    app.click('baro-tf-3M');
    app.change('fx-event-select', '0');
    app.flush();
    eq('horizon chosen on main-tab buttons (3M) survives event change', app.state().horizon, '3M');
});

section('3. Latest Snapshot exits event mode and clears custom range', async () => {
    const app = await mainApp();
    app.run("activeCustomRange = { start: new Date('2015-01-01'), end: new Date('2015-02-01') }");
    app.click(app.all('.event-btn')[0]);
    check('entering event mode clears legacy activeCustomRange', app.run('activeCustomRange') === null);
    app.flush();
    app.click('master-tf-3M');
    app.run("activeCustomRange = { start: new Date('2015-01-01'), end: new Date('2015-02-01') }");

    app.click('today-btn');                       // real inline onclick="resetToToday()"
    app.flush();
    const s = app.state();
    check('reset: active=false', s.active === false);
    ['eventIdx', 'eventId', 'event', 'archiveDate', 'baselineDate', 'firstSessionDate', 'endDate', 'incompleteReason']
        .forEach(k => check(`reset: ${k} is null`, s[k] === null));
    check('reset: isComplete back to true', s.isComplete === true);
    check('reset: activeCustomRange cleared', app.run('activeCustomRange') === null);
    check('reset: legacy activeEventMode false / activeEventIdx null',
        app.run('activeEventMode') === false && app.run('activeEventIdx') === null);
    check('reset: today-btn active', app.byId('today-btn')._classes.has('active'));
    check('reset: no event-btn active', app.all('.event-btn').every(b => !b._classes.has('active')));
    eq('reset: fx dropdown shows snapshot', app.byId('fx-event-select').value, 'snapshot');
    eq('reset: timeframe buttons return to snapshot state (baro 1Y, master 5Y)',
        [app.activeIds('baro-tf-btn'), app.activeIds('master-tf-btn')], [['baro-tf-1Y'], ['master-tf-5Y']]);
    check('reset: master chart redrawn (live)', app.liveChart('master-canvas') !== null);
    check('reset: barometer chart redrawn (live)', app.liveChart('barometer-canvas') !== null);
    const sub = app.byId('master-chart-subtitle');
    check('reset: event subtitle cleared and hidden', sub && sub.textContent === '' && sub.style.display === 'none');
    check('reset: impact panel shows snapshot placeholder', app.panelHtml().includes('LATEST SNAPSHOT ACTIVE'));

    // Snapshot-mode timeframe button clears custom range
    app.run("activeCustomRange = { start: new Date('2015-01-01'), end: new Date('2015-02-01') }");
    app.click('master-tf-1Y');
    check('snapshot setMasterTimeframe clears custom range', app.run('activeCustomRange') === null);
    eq('snapshot setMasterTimeframe updates activeMasterTimeframe', app.run('activeMasterTimeframe'), '1Y');
    eq('snapshot buttons follow', app.activeIds('master-tf-btn'), ['master-tf-1Y']);
    eq('snapshot timeframe click leaves shared event horizon untouched', app.state().horizon, '3M');
});

section('4. Horizon controls update both charts, buttons and panel', async () => {
    const app = await mainApp();
    app.click(app.all('.event-btn')[0]);
    app.flush();
    // [horizon, index of the endpoint in the Gold/WTI fixture (baseline idx 1 + n)]
    const H = [['1W', 6], ['1M', 23], ['3M', 64], ['6M', 127], ['YTD', 260], ['1Y', 253], ['5Y', 1261], ['MAX', 1299]];
    H.forEach(([h, endIdx], i) => {
        const control = (i % 2 === 0) ? `master-tf-${h}` : `baro-tf-${h}`; // alternate between tabs
        app.click(control);
        const expectEnd = LIN_GOLD.labels[endIdx];
        eq(`${h}: shared horizon`, app.state().horizon, h);
        eq(`${h}: legacy activeEventHorizon`, app.run('activeEventHorizon'), h);
        eq(`${h}: exactly one active button per tab`, [app.activeIds('baro-tf-btn'), app.activeIds('master-tf-btn')],
            [[`baro-tf-${h}`], [`master-tf-${h}`]]);
        const mc = app.liveChart('master-canvas');
        const bc = app.liveChart('barometer-canvas');
        check(`${h}: master chart rebuilt`, mc !== null);
        check(`${h}: barometer chart rebuilt`, bc !== null);
        if (mc) eq(`${h}: master chart ends ${expectEnd}`, mc.config.data.labels[mc.config.data.labels.length - 1], expectEnd);
        if (bc) eq(`${h}: barometer chart ends ${expectEnd}`, bc.config.data.labels[bc.config.data.labels.length - 1], expectEnd);
        eq(`${h}: shared endDate`, app.state().endDate, expectEnd);
        // CHANGED (requirement D): in event mode YTD is labelled "Event-year end". Old expectation: "(YTD)" / "Horizon: <strong>YTD</strong>".
        const shown = h === 'YTD' ? 'Event-year end' : h;
        check(`${h}: barometer title names horizon`, app.byId('barometer-chart-title').textContent.includes(`(${shown})`));
        check(`${h}: impact panel shows horizon`, app.panelHtml().includes(`Horizon: <strong>${shown}</strong>`));
        eq(`${h}: only one live chart per canvas (old destroyed)`,
            [app.charts('master-canvas').filter(c => !c.destroyed).length, app.charts('barometer-canvas').filter(c => !c.destroyed).length],
            [1, 1]);
    });
});

section('5. Pre-event context does not change the return baseline', async () => {
    const P = { '2020-03-02': 200, '2020-03-03': 202, '2020-03-04': 204, '2020-03-05': 206, '2020-03-06': 208,
        '2020-03-09': 210, '2020-03-10': 212, '2020-03-11': 214, '2020-03-12': 216, '2020-03-13': 220,
        '2020-03-16': 224, '2020-03-17': 228, '2020-03-18': 232, '2020-03-19': 236, '2020-03-20': 240 };
    const allDates = Object.keys(P);
    const longSeries = { labels: allDates, prices: allDates.map(d => P[d]) };
    const shortDates = allDates.filter(d => d >= '2020-03-11');
    const shortSeries = { labels: shortDates, prices: shortDates.map(d => P[d]) };
    const app = await loadApp({
        commodities: { Gold: longSeries, 'WTI Crude': shortSeries },
        events: [{ name: 'Context Event', date: '2020-03-16' }],
        now: '2020-03-20T12:00:00Z'
    });

    const a = slice(longSeries.labels, longSeries.prices, '2020-03-16', '1W', app);
    const b = slice(shortSeries.labels, shortSeries.prices, '2020-03-16', '1W', app);
    eq('long history: 5 context obs', [a.preEventContextCount, a.contextLimited], [5, false]);
    eq('short history: 2 context obs', [b.preEventContextCount, b.contextLimited], [2, true]);
    eq('baseline date identical regardless of context', [a.baselineDate, b.baselineDate], ['2020-03-13', '2020-03-13']);
    eq('baseline price identical regardless of context', [a.baselinePrice, b.baselinePrice], [220, 220]);
    eq('endpoint date/price identical', [a.endDate, b.endDate], ['2020-03-20', '2020-03-20']);
    eq('endpoint price identical', [a.prices[a.prices.length - 1], b.prices[b.prices.length - 1]], [240, 240]);
    eq('context obs are the 5 closes before the baseline', a.labels.slice(0, 5), ['2020-03-06', '2020-03-09', '2020-03-10', '2020-03-11', '2020-03-12']);
    eq('baselineIdx points at baseline inside the window', [a.baselineIdx, b.baselineIdx], [5, 2]);

    app.click(app.all('.event-btn')[0]);
    app.click('master-tf-1W');
    app.flush();
    const mc = app.liveChart('master-canvas');
    const labels = mc.config.data.labels;
    const gold = mc.config.data.datasets.find(d => d.label.startsWith('Gold')).data;
    const wti = mc.config.data.datasets.find(d => d.label.startsWith('WTI Crude')).data;
    const iB = labels.indexOf('2020-03-13');
    const iFirst = labels.indexOf('2020-03-06');
    eq('master chart: baseline point is 0.000% for both series', [gold[iB], wti[iB]], [0, 0]);
    eq('master chart: first context point is NOT normalised to 0 (-12/220)', gold[iFirst], -5.455);
    eq('master chart: short-history series has no value before its first obs', wti[iFirst], null);
    eq('master chart: endpoint return identical for both series (+9.091%)', [gold[labels.length - 1], wti[labels.length - 1]], [9.091, 9.091]);

    const rows = parseAudit(app.panelHtml());
    eq('panel: same baseline price for both series', [rows.Gold.base, rows['WTI Crude'].base], ['$220.00', '$220.00']);
    eq('panel: same 1D (T+1 = 224) return', [rows.Gold.cells[0], rows['WTI Crude'].cells[0]], ['+1.82%', '+1.82%']);
    eq('panel: same 1W (T+5 = 240) return', [rows.Gold.cells[1], rows['WTI Crude'].cells[1]], ['+9.09%', '+9.09%']);
});

section('6. Exact baseline, endpoint, price and return values', async () => {
    const app = await mainApp();
    const G = LIN_GOLD;
    const H = [['1W', 5, 6, '2015-01-09', '4.95'], ['1M', 22, 23, '2015-02-03', '21.78'],
        ['3M', 63, 64, '2015-04-01', '62.38'], ['6M', 126, 127, '2015-06-29', '124.75'],
        ['1Y', 252, 253, '2015-12-22', '249.50'], ['5Y', 1260, 1261, '2019-11-01', '1247.52']];
    H.forEach(([h, n, idx, endDate, pct]) => {
        const r = slice(G.labels, G.prices, '2015-01-05', h, app);
        check(`${h}: has data`, r.noData === false);
        eq(`${h}: baseline date (last obs strictly before 2015-01-05)`, r.baselineDate, '2015-01-02');
        eq(`${h}: baseline price`, r.baselinePrice, 101);
        eq(`${h}: first market session`, r.firstSessionDate, '2015-01-05');
        eq(`${h}: endpoint date`, r.endDate, endDate);
        eq(`${h}: endpoint price`, r.prices[r.prices.length - 1], 100 + idx);
        eq(`${h}: requested / actual post-baseline obs`, [r.requestedObs, r.actualPostEventObs], [n, n]);
        eq(`${h}: complete`, [r.horizonComplete, r.incompleteReason], [true, null]);
        eq(`${h}: window length = 1 context + baseline + ${n}`, r.labels.length, 1 + 1 + n);
        eq(`${h}: price return %`, ((r.prices[r.prices.length - 1] - r.baselinePrice) / r.baselinePrice * 100).toFixed(2), pct);
    });

    const r5 = slice(G.labels, G.prices, '2015-01-19', '1W', app);
    eq('full 5-obs context when history allows', [r5.preEventContextCount, r5.contextLimited, r5.baselineDate, r5.baselinePrice],
        [5, false, '2015-01-16', 111]);

    // Panel: 1D / 1W / 1M / 1Y table from production HTML, and 5Y via horizon box
    app.click(app.all('.event-btn')[0]);
    app.flush();
    let rows = parseAudit(app.panelHtml());
    eq('panel Gold baseline', rows.Gold.base, '$101.00');
    eq('panel Gold returns 1D/1W/1M/1Y', rows.Gold.cells, ['+0.99%', '+4.95%', '+21.78%', '+249.50%']);
    eq('panel WTI baseline', rows['WTI Crude'].base, '$51.00');
    eq('panel WTI returns 1D/1W/1M/1Y', rows['WTI Crude'].cells, ['+1.96%', '+9.80%', '+43.14%', '+494.12%']);
    eq('panel Gold 1D tooltip (endpoint date/price + baseline)', rows.Gold.titles[0],
        '1D (T+1): 2015-01-05 @ $102.00 (Baseline: 2015-01-02 @ $101.00)');
    eq('panel Gold 1W tooltip', rows.Gold.titles[1], '1W (T+5): 2015-01-09 @ $106.00 (Baseline: 2015-01-02 @ $101.00)');
    eq('panel Gold 1M tooltip', rows.Gold.titles[2], '1M (T+22): 2015-02-03 @ $123.00 (Baseline: 2015-01-02 @ $101.00)');
    eq('panel Gold 1Y tooltip', rows.Gold.titles[3], '1Y (T+252): 2015-12-22 @ $353.00 (Baseline: 2015-01-02 @ $101.00)');
    let boxes = parseBoxes(app.panelHtml());
    eq('1M box winner (WTI 22/51)', boxes.winner, { name: 'WTI CRUDE', stats: '1M RETURN: +43.14%' });
    eq('1M box loser (Gold 22/101)', boxes.loser, { name: 'GOLD', stats: '1M RETURN: +21.78%' });

    app.click('master-tf-5Y');
    boxes = parseBoxes(app.panelHtml());
    eq('5Y box winner (WTI 1260/51)', boxes.winner, { name: 'WTI CRUDE', stats: '5Y RETURN: +2470.59%' });
    eq('5Y box loser (Gold 1260/101)', boxes.loser, { name: 'GOLD', stats: '5Y RETURN: +1247.52%' });
    check('5Y box shows endpoint date and price', app.panelHtml().includes('$101.00 (2015-01-02) → $1361.00 (2019-11-01)'));
    rows = parseAudit(app.panelHtml());
    eq('T+n table is independent of the selected horizon', rows.Gold.cells, ['+0.99%', '+4.95%', '+21.78%', '+249.50%']);

    // Sector backtest table uses the same offsets
    const sectorText = textOf(app.byId('sector-flow-container'));
    check('sector backtest discloses strictly-before baseline', sectorText.includes('Baseline: last close strictly before 2015-01-05'));
});

section('7. MAX and event-year-end (YTD) behaviour', async () => {
    const app = await mainApp();
    const G = LIN_GOLD;
    const max = slice(G.labels, G.prices, '2015-01-05', 'MAX', app);
    eq('MAX: ends at last observation', [max.endDate, max.prices[max.prices.length - 1]], ['2019-12-25', 1399]);
    eq('MAX: requestedObs "all", complete, all post-baseline obs', [max.requestedObs, max.horizonComplete, max.actualPostEventObs], ['all', true, 1298]);

    const ytd = slice(G.labels, G.prices, '2015-01-05', 'YTD', app);
    eq('YTD: ends at last obs of the event calendar year', [ytd.endDate, ytd.horizonComplete], ['2015-12-31', true]);
    eq('YTD: requestedObs label', ytd.requestedObs, 'event year-end');

    // Event year has no data at all after the baseline
    const none = slice(['2019-12-30', '2019-12-31'], [1, 2], '2020-01-01', 'YTD', app);
    eq('YTD with no observations in event year: incomplete, ends at baseline',
        [none.horizonComplete, none.endDate, none.actualPostEventObs], [false, '2019-12-31', 0]);
    check('YTD incomplete reason names the year', (none.incompleteReason || '').includes('2020'));

    // Holiday-boundary event: baseline in prior year, YTD measured in event year
    const hol = slice(['2019-12-30', '2019-12-31', '2020-01-02'], [1, 2, 3], '2020-01-01', 'YTD', app);
    // CHANGED (requirement D): old expectation horizonComplete=true ("any observation in the event year"). Event-year end
    // is covered only when a record on/after Dec 31 exists; data ending 2020-01-02 is far short of 2020-12-31.
    eq('YTD for 1 Jan event: baseline 2019-12-31, ends 2020-01-02, year-end NOT covered', [hol.baselineDate, hol.endDate, hol.horizonComplete, hol.coverage],
        ['2019-12-31', '2020-01-02', false, 'incomplete']);

    // Incomplete coverage: data stops in June of the event year
    const cut = linear('2020-01-01', 130, 100);
    eq('fixture ends 2020-06-30', cut.labels[cut.labels.length - 1], '2020-06-30');
    const trunc = slice(cut.labels, cut.prices, '2020-03-10', 'YTD', app);
    eq('YTD truncated year: window ends at last available obs', trunc.endDate, '2020-06-30');
    evidence('D7 YTD truncated', { lastLabel: cut.labels[cut.labels.length - 1], endDate: trunc.endDate, horizonComplete: trunc.horizonComplete, incompleteReason: trunc.incompleteReason });
    check('YTD truncated year must be flagged incomplete (data stops before year end)',
        trunc.horizonComplete === false && !!trunc.incompleteReason, 'D7');

    const cutMax = slice(cut.labels, cut.prices, '2020-03-10', 'MAX', app);
    eq('MAX with short history: all obs after baseline', [cutMax.endDate, cutMax.horizonComplete], ['2020-06-30', true]);
});

section('8. Date-only events: weekends, first/last observation', async () => {
    const app = await mainApp();
    const L = ['2023-10-02', '2023-10-03', '2023-10-04', '2023-10-05', '2023-10-06', '2023-10-09', '2023-10-10'];
    const P = [100, 101, 102, 103, 104, 105, 106];
    ['2023-10-07', '2023-10-08'].forEach(d => {
        const r = slice(L, P, d, '1W', app);
        eq(`${d} (weekend): baseline = Friday close`, [r.baselineDate, r.baselinePrice, r.baselineIdx], ['2023-10-06', 104, 4]);
        eq(`${d} (weekend): first session = Monday`, r.firstSessionDate, '2023-10-09');
        eq(`${d} (weekend): context limited to 4`, [r.preEventContextCount, r.contextLimited], [4, true]);
        eq(`${d} (weekend): 1W incomplete with 2 post-baseline obs`, [r.horizonComplete, r.actualPostEventObs, r.endDate], [false, 2, '2023-10-10']);
    });
    const mon = slice(L, P, '2023-10-09', '1W', app);
    eq('Monday event: baseline still Friday (strictly before)', [mon.baselineDate, mon.firstSessionDate], ['2023-10-06', '2023-10-09']);
    const wed = slice(L, P, '2023-10-04', 'MAX', app);
    eq('weekday event with data on the date: baseline is prior day', [wed.baselineDate, wed.firstSessionDate], ['2023-10-03', '2023-10-04']);

    const first = slice(L, P, '2023-10-02', '1W', app);
    check('event on first observation: explicit noData', first.noData === true);
    check('event on first observation: reason says no pre-event baseline', (first.reason || '').includes('No pre-event baseline'));
    eq('event on first observation: baseline fields null, labels empty',
        [first.baselineDate, first.baselinePrice, first.labels, first.incompleteReason, first.horizonComplete],
        [null, null, [], 'Baseline unavailable', false]);

    // CHANGED (requirement B): old event date 2023-10-20 is 10 days after the last observation (2023-10-10), so the
    // baseline would now be too old. The original assertions are kept with an event 3 days after the last observation;
    // the too-old case is asserted separately below.
    const after = slice(L, P, '2023-10-13', '1W', app);
    eq('event after last observation: baseline = last obs', [after.noData, after.baselineDate, after.baselinePrice], [false, '2023-10-10', 106]);
    eq('event after last observation: no first session, 0 forward obs, incomplete',
        [after.firstSessionDate, after.actualPostEventObs, after.horizonComplete], [null, 0, false]);

    const tooOld = slice(L, P, '2023-10-20', '1W', app);
    eq('event 10 days after the last observation: baseline too old -> noData, candidate named, no return basis',
        [tooOld.noData, tooOld.baselineDate, tooOld.baselinePrice, tooOld.baselineCandidateDate, tooOld.baselineCandidateAgeDays], [true, null, null, '2023-10-10', 10]);
    check('empty labels: noData', slice([], [], '2023-10-07', '1W', app).noData === true);
    check('missing event date: noData', slice(L, P, '', '1W', app).noData === true);
    check('null event date: noData', slice(L, P, null, '1W', app).noData === true);

    // Through the UI: Saturday event on the linear fixture (2015-03-07)
    const ui = await mainApp();
    ui.click(ui.all('.event-btn')[1]);
    ui.flush();
    const s = ui.state();
    eq('UI Saturday event: baseline Friday, first session Monday', [s.baselineDate, s.firstSessionDate], ['2015-03-06', '2015-03-09']);
    check('UI Saturday event: subtitle discloses first post-event session',
        ui.byId('master-chart-subtitle').textContent.includes('First post-event session: 2015-03-09'));
    const rows = parseAudit(ui.panelHtml());
    eq('UI Saturday event: Gold baseline and T+1 (Monday close)', [rows.Gold.base, rows.Gold.cells[0]], ['$146.00', '+0.68%']);
    eq('UI Saturday event: T+1 tooltip dates the Monday session', rows.Gold.titles[0],
        '1D (T+1): 2015-03-09 @ $147.00 (Baseline: 2015-03-06 @ $146.00)');

    // Pre-data event through the UI
    ui.click(ui.all('.event-btn')[3]);
    ui.flush();
    check('UI pre-data event: panel says no series had valid pre-event data', ui.panelHtml().includes('No commodity series had valid pre-event data for 2001-01-01'));
});

section('9. Bad data: unsorted, mismatched, null, non-finite', async () => {
    const app = await mainApp();

    // Unsorted dates
    const uL = ['2020-01-03', '2020-01-01', '2020-01-02', '2020-01-06', '2020-01-07'];
    const uP = [103, 101, 102, 106, 107];
    const u = slice(uL, uP, '2020-01-06', '1W', app);
    evidence('D5 unsorted', { noData: u.noData, baselineDate: u.baselineDate, baselinePrice: u.baselinePrice, labels: u.labels });
    check('unsorted dates: explicit noData OR the correct baseline (2020-01-03 @ 103), never a silently wrong one',
        u.noData === true || (u.baselineDate === '2020-01-03' && u.baselinePrice === 103), 'D5');
    if (!u.noData) {
        check('unsorted dates: any returned window is chronological',
            u.labels.every((d, i) => i === 0 || u.labels[i - 1] <= d), 'D5');
    }

    // Mismatched lengths: 8 labels, 6 prices
    const mL = weekdays('2020-01-01', 8);
    const mP = [1, 2, 3, 4, 5, 6];
    const m = slice(mL, mP, '2020-01-03', '1W', app);
    evidence('D6 mismatch', { noData: m.noData, labels: m.labels.length, prices: m.prices.length, endDate: m.endDate, lastPrice: m.prices[m.prices.length - 1], horizonComplete: m.horizonComplete });
    check('mismatch: explicit noData OR labels and prices stay aligned',
        m.noData === true || m.labels.length === m.prices.length, 'D6');
    const mBase = slice(mL, mP, '2020-01-10', '1W', app);
    check('mismatch: baseline with no price -> noData with reason', mBase.noData === true && (mBase.reason || '').length > 0);

    // CHANGED (requirement B). Old expectation (pinned as "current behaviour"): an invalid nearest pre-event price gave
    // noData and never borrowed an earlier close. New rule: search past null/undefined/non-finite prices for the latest
    // finite earlier price, at most 7 calendar days before the event; otherwise unavailable with the candidate named.
    const d5 = weekdays('2020-01-01', 5); // 01-01 01-02 01-03 01-06 01-07
    [['null', null], ['NaN', NaN], ['undefined', undefined], ['numeric string', '12'], ['Infinity', Infinity], ['-Infinity', -Infinity]].forEach(([name, v]) => {
        const r = slice(d5, [1, 2, v, 4, 5], '2020-01-06', '1W', app);
        eq(`${name} nearest pre-event price: earlier finite price 2020-01-02 @ 2 is the baseline (age 4 d, 1 record searched past)`,
            [r.noData, r.baselineDate, r.baselinePrice, r.baselineAgeDays, r.baselineSkipped], [false, '2020-01-02', 2, 4, 1], name.includes('Infinity') ? 'D1' : undefined);
        check(`${name} nearest pre-event price: invalid record stays in the window as a null gap, offsets not shifted`,
            r.labels.includes('2020-01-03') && r.prices[r.labels.indexOf('2020-01-03')] === null && r.actualPostEventObs === 3);
    });
    const allBad = slice(d5, [null, NaN, undefined, 4, 5], '2020-01-06', '1W', app);
    check('every pre-event price invalid: explicit noData with reason', allBad.noData === true && /No valid price/.test(allBad.reason || ''));
    const oldOnly = slice(['2019-12-20', '2020-01-03', '2020-01-06'], [1, null, 4], '2020-01-06', '1W', app);
    check('invalid nearest price and earlier one too old: noData', oldOnly.noData === true && oldOnly.baselinePrice === null);
    eq('too-old candidate is named, never used', [oldOnly.baselineCandidateDate, oldOnly.baselineCandidateAgeDays, oldOnly.baselineDate], ['2019-12-20', 17, null]);
    check('reason names the candidate date and the limit', /2019-12-20/.test(oldOnly.reason || '') && /limit 7/.test(oldOnly.reason || ''));
    // Zero baseline: slicer returns it, consumers must exclude it
    const zero = slice(weekdays('2020-01-01', 5), [1, 2, 0, 4, 5], '2020-01-06', '1W', app);
    eq('zero baseline is reported as-is by the slicer (consumers must guard)', [zero.noData, zero.baselinePrice], [false, 0]);
});

// 9b is split into independent sections so that one failing scenario (for
// example an uncaught exception in a deferred callback) cannot hide the others.
const B9_BASE = weekdays('2015-01-01', 60);
const b9 = (mut) => { const p = B9_BASE.map((_, i) => 100 + i); mut(p); return { labels: B9_BASE, prices: p }; };
const B9_WTI = { labels: B9_BASE, prices: B9_BASE.map((_, i) => 50 + i) };

section('9b-i. Null price at the horizon endpoint (UI panels and master chart)', async () => {
    // Gold prices[23] (the 1M endpoint for event 2015-01-05) is null.
    const app = await loadApp({ commodities: { Gold: b9(p => { p[23] = null; }), 'WTI Crude': B9_WTI }, events: [EVENTS_MAIN[0]] });
    app.click(app.all('.event-btn')[0]);
    app.flush();
    const errs = app.takeTimerErrors(); // uncaught errors from deferred callbacks, as a browser would report them
    check(`deferred impact/sector callback completes without an uncaught exception${errs.length ? ` (got: ${errs[0].message})` : ''}`,
        errs.length === 0, 'D2');
    evidence('D2 deferred error', errs.length ? String(errs[0].stack).split('\n').slice(0, 3).join(' | ') : 'none');
    evidence('D2 panel html length after callback', app.panelHtml().length);
    const rows = parseAudit(app.panelHtml());
    const rendered = 'Gold' in rows && 'WTI Crude' in rows;
    check('impact panel is still rendered after a null endpoint (not left blank)', rendered, 'D2');
    if (rows.Gold) {
        eq('null endpoint: T+22 cell is N/A (not a number)', rows.Gold.cells[2], 'N/A');
        eq('null endpoint: other offsets unaffected', [rows.Gold.cells[0], rows.Gold.cells[1]], ['+0.99%', '+4.95%']);
    }
    check('null endpoint must not be reported as a -100.00% horizon return', rendered && !/-100\.00%/.test(app.panelHtml()), 'D2');
    check('sector backtest (same deferred callback) still refreshed',
        textOf(app.byId('sector-flow-container')).includes('RETROSPECTIVE PRICE IMPACT'), 'D2');
    const mc = app.liveChart('master-canvas');
    const goldData = mc.config.data.datasets[0].data;
    eq('null endpoint: master chart leaves a gap (null) at 2015-02-03', goldData[mc.config.data.labels.indexOf('2015-02-03')], null);
    eq('null endpoint: master chart spanGaps false', mc.config.data.datasets[0].spanGaps, false);
});

section('9b-ii. Infinity price inside the horizon (UI panels and master chart)', async () => {
    const app = await loadApp({ commodities: { Gold: b9(p => { p[2] = Infinity; }), 'WTI Crude': B9_WTI }, events: [EVENTS_MAIN[0]] });
    app.click(app.all('.event-btn')[0]);
    app.flush();
    check('no uncaught deferred-callback exception', app.takeTimerErrors().length === 0);
    const rows = parseAudit(app.panelHtml());
    check('impact panel rendered', 'Gold' in rows);
    evidence('D1 Infinity T+1 row', rows.Gold);
    evidence('D1 Infinity master Gold data (first 6)', app.liveChart('master-canvas').config.data.datasets[0].data.slice(0, 6).map(String));
    check('Infinity price: T+1 cell is N/A, not "Infinity%"', !!rows.Gold && rows.Gold.cells[0] === 'N/A', 'D1');
    check('Infinity price: panel never prints Infinity/NaN', !/Infinity|NaN/.test(app.panelHtml()), 'D1');
    const goldData = app.liveChart('master-canvas').config.data.datasets[0].data;
    check('Infinity price: master chart values are all finite or null', goldData.every(v => v === null || Number.isFinite(v)), 'D1');
});

section('9b-iii. Zero baseline is excluded, not divided by', async () => {
    const app = await loadApp({ commodities: { Gold: b9(p => { p[1] = 0; }), 'WTI Crude': B9_WTI }, events: [EVENTS_MAIN[0]] });
    app.click(app.all('.event-btn')[0]);
    app.flush();
    check('no uncaught deferred-callback exception', app.takeTimerErrors().length === 0);
    check('zero baseline: panel has no Infinity/NaN/undefined', !/Infinity|NaN|undefined/.test(app.panelHtml()));
    const rows = parseAudit(app.panelHtml());
    check('zero baseline: Gold excluded from audit table, WTI kept', !('Gold' in rows) && 'WTI Crude' in rows);
    const mc = app.liveChart('master-canvas');
    check('zero baseline: Gold shown as excluded in master legend', mc.config.data.datasets.some(d => d.label.startsWith('Gold (Excluded:')));
});

section('9b-iv. Sector backtest with a null observation', async () => {
    const app = await loadApp({ events: [EVENTS_MAIN[0]], sectors: { XLK: sectorSeries(2) } });
    app.click(app.all('.event-btn')[0]);
    app.flush();
    check('no uncaught deferred-callback exception', app.takeTimerErrors().length === 0);
    const row = app.byId('sector-flow-container').children.find(c => c._html.includes('TECHNOLOGY (XLK)'));
    check('sector backtest: XLK row rendered', !!row);
    const rowText = row ? stripTags(row._html) : '';
    evidence('D4 XLK row', rowText);
    const pick = (label) => { const m = new RegExp(`${label}:\\s*(\\S+)`).exec(rowText); return m ? m[1] : null; };
    eq('sector backtest: 1W (T+5 = 56 vs 51) is +9.80%', pick('1W'), '9.80%');
    eq('sector backtest: 1M (T+22 = 73 vs 51) is +43.14%', pick('1M'), '43.14%');
    eq('sector backtest: 1Y beyond history is N/A', pick('1Y'), 'N/A');
    check('sector backtest: null observation at T+1 is N/A, not -100.00%', pick('1D') === 'N/A', 'D4');
});

section('10. Multi-series comparison aligns by date and preserves gaps', async () => {
    const gold = {
        labels: ['2020-03-09', '2020-03-10', '2020-03-11', '2020-03-12', '2020-03-13', '2020-03-16', '2020-03-17', '2020-03-18', '2020-03-19', '2020-03-20'],
        prices: [90, 92, 94, 96, 100, 110, 120, 130, 125, 140]
    };
    const wti = {
        labels: ['2020-03-10', '2020-03-11', '2020-03-12', '2020-03-13', '2020-03-16', '2020-03-18', '2020-03-19', '2020-03-20'],
        prices: [46, 47, 48, 50, 55, 60, 45, 70]
    };
    const silver = { labels: ['2020-03-16', '2020-03-17', '2020-03-18'], prices: [16, 17, 18] }; // starts after the event
    const app = await loadApp({
        commodities: { Gold: gold, 'WTI Crude': wti, Silver: silver },
        events: [{ name: 'Multi Event', date: '2020-03-16' }],
        now: '2020-03-20T12:00:00Z'
    });
    app.setChecked(['Gold', 'WTI Crude', 'Silver']);
    app.click(app.all('.event-btn')[0]);
    app.click('master-tf-1W');
    app.flush();

    const mc = app.liveChart('master-canvas');
    const cfg = mc.config.data;
    eq('x-axis is the sorted union of valid dates in the windows', cfg.labels, gold.labels);
    eq('dataset order and labels (WTI ends early -> [Incomplete]; Silver excluded with reason)',
        cfg.datasets.map(d => d.label.replace(/\(Excluded: .*\)$/, '(Excluded: …)')),
        ['Gold', 'WTI Crude [Incomplete]', 'Silver (Excluded: …)']);
    check('excluded reason is the slicer reason', cfg.datasets[2].label.includes('No pre-event baseline observation'));
    eq('Gold: each point is % vs Gold\'s own baseline (100 on 03-13)', cfg.datasets[0].data, [-10, -8, -6, -4, 0, 10, 20, 30, 25, 40]);
    eq('WTI: normalised to its own baseline (50); missing dates stay null gaps',
        cfg.datasets[1].data, [null, -8, -6, -4, 0, 10, null, 20, -10, 40]);
    eq('excluded series is an all-null placeholder', cfg.datasets[2].data.every(v => v === null), true);
    check('spanGaps is false on every dataset (gaps preserved)', cfg.datasets.every(d => d.spanGaps === false));
    const iB = cfg.labels.indexOf('2020-03-13');
    eq('baseline marker radius 5 at 03-13 on both eligible series', [cfg.datasets[0].pointRadius[iB], cfg.datasets[1].pointRadius[iB]], [5, 5]);
    eq('no marker elsewhere', cfg.datasets[0].pointRadius.filter(r => r !== 0).length, 1);

    const s = app.state();
    eq('shared baseline/end from first eligible series', [s.baselineDate, s.endDate], ['2020-03-13', '2020-03-20']);
    eq('isComplete false because WTI is incomplete; reason is surfaced', [s.isComplete, /history ends after 4 obs/.test(s.incompleteReason || '')], [false, true]);
    const sub = app.byId('master-chart-subtitle').textContent;
    check('subtitle discloses baseline convention, horizon and INCOMPLETE status',
        sub.includes('Baseline: 2020-03-13') && sub.includes('Horizon: 1W') && sub.includes('INCOMPLETE'));

    // Panel: each series uses its own baseline and dates
    const rows = parseAudit(app.panelHtml());
    eq('panel: Gold and WTI baselines', [rows.Gold.base, rows['WTI Crude'].base], ['$100.00', '$50.00']);
    check('panel: Silver (no baseline) is absent', !('Silver' in rows));
    eq('panel: WTI T+1 is the next WTI session (03-16 @ 55), not a calendar neighbour',
        rows['WTI Crude'].titles[0], '1D (T+1): 2020-03-16 @ $55.00 (Baseline: 2020-03-13 @ $50.00)');
    eq('panel: WTI T+5 is unavailable (only 4 obs after baseline)', rows['WTI Crude'].cells[1], 'N/A');
    eq('panel: Gold T+5 = 03-20 @ 140', rows.Gold.titles[1], '1W (T+5): 2020-03-20 @ $140.00 (Baseline: 2020-03-13 @ $100.00)');
});

section('11. Incomplete horizons are explicit, never silently substituted', async () => {
    const short = (base) => linear('2015-01-01', 15, base);
    const app = await loadApp({
        commodities: { Gold: short(100), 'WTI Crude': short(50) },
        // CHANGED (requirement B): was date 2030-01-01. With a 7-day baseline limit an event years after the data would have NO usable baseline;
        // 2015-01-23 is 2 days after the last observation (2015-01-21), so the intended zero-forward-observation case is preserved.
        events: [EVENTS_MAIN[0], { name: 'Beyond Data', date: '2015-01-23' }]
    });

    // Slicer level
    const g = slice(short(100).labels, short(100).prices, '2015-01-05', '1M', app);
    eq('slicer: 1M flagged incomplete with real counts', [g.horizonComplete, g.requestedObs, g.actualPostEventObs, g.endDate], [false, 22, 13, '2015-01-21']);
    check('slicer: reason states requested vs available', (g.incompleteReason || '').includes('Requested 22 trading obs (1M)') && g.incompleteReason.includes('history ends after 13 obs'));
    const lin = slice(LIN_GOLD.labels.slice(0, 1100), LIN_GOLD.prices.slice(0, 1100), '2015-01-05', '5Y', app);
    eq('slicer: 5Y on 1100 obs incomplete, 1098 post-baseline obs, ends at last obs',
        [lin.horizonComplete, lin.actualPostEventObs, lin.endDate], [false, 1098, LIN_GOLD.labels[1099]]);
    const exact = slice(LIN_GOLD.labels.slice(0, 1262), LIN_GOLD.prices.slice(0, 1262), '2015-01-05', '5Y', app);
    eq('slicer: exactly 1260 post-baseline obs is complete (boundary)', [exact.horizonComplete, exact.actualPostEventObs], [true, 1260]);
    const one = slice(LIN_GOLD.labels.slice(0, 1261), LIN_GOLD.prices.slice(0, 1261), '2015-01-05', '5Y', app);
    eq('slicer: one obs short of 1260 is incomplete (boundary)', [one.horizonComplete, one.actualPostEventObs], [false, 1259]);

    // Panel, event with partial coverage
    app.click(app.all('.event-btn')[0]);
    app.flush();
    let rows = parseAudit(app.panelHtml());
    eq('panel: available offsets shown, unavailable offsets are N/A', rows.Gold.cells, ['+0.99%', '+4.95%', 'N/A', 'N/A']);
    const st = app.state();
    check('state: isComplete=false with a reason', st.isComplete === false && !!st.incompleteReason);
    check('master subtitle marks INCOMPLETE', app.byId('master-chart-subtitle').textContent.includes('INCOMPLETE'));
    check('master legend tags series [Incomplete]', app.liveChart('master-canvas').config.data.datasets.every(d => d.label.endsWith('[Incomplete]')));
    check('panel status says Incomplete', app.panelHtml().includes('Status: <span style="color:var(--amber);">Incomplete</span>'));
    let boxes = parseBoxes(app.panelHtml());
    evidence('D3 incomplete 1M boxes', boxes);
    evidence('D3 incomplete 1M state', { isComplete: st.isComplete, reason: st.incompleteReason });
    check('winner box must not present a numeric "1M RETURN" for an incomplete 1M horizon',
        boxes.winner && !hasNumericHorizonReturn(boxes.winner.stats, '1M'), 'D3');
    check('loser box must not present a numeric "1M RETURN" for an incomplete 1M horizon',
        boxes.loser && !hasNumericHorizonReturn(boxes.loser.stats, '1M'), 'D3');

    // Event after the data: zero forward observations
    app.change('fx-event-select', '1');
    app.flush();
    rows = parseAudit(app.panelHtml());
    eq('beyond-data event: every T+n is N/A', rows.Gold.cells, ['N/A', 'N/A', 'N/A', 'N/A']);
    eq('beyond-data event: baseline is the last observation', [rows.Gold.base, app.state().baselineDate], ['$114.00', '2015-01-21']);
    eq('beyond-data event: no first session', app.state().firstSessionDate, null);
    boxes = parseBoxes(app.panelHtml());
    evidence('D3 beyond-data boxes', boxes);
    check('beyond-data event must not present a numeric horizon return (e.g. +0.00%) for zero forward obs',
        boxes.winner && boxes.loser && !hasNumericHorizonReturn(boxes.winner.stats, '1M') && !hasNumericHorizonReturn(boxes.loser.stats, '1M'), 'D3');
});

section('12. Recovery from empty selection / empty window', async () => {
    const msgOf = (app, wrapId) => app.byId(wrapId).querySelector('.chart-no-data-msg');

    // a) empty instrument selection (event mode), then restore
    let app = await mainApp();
    app.click(app.all('.event-btn')[0]);
    app.flush();
    check('precondition: master chart live in event mode', app.liveChart('master-canvas') !== null);
    app.setChecked([]);
    app.run('updateMasterChart()');
    check('empty selection: master chart destroyed', app.liveChart('master-canvas') === null);
    eq('empty selection: canvas hidden', app.byId('master-canvas').style.display, 'none');
    check('empty selection: guidance message shown', (msgOf(app, 'master-canvas-wrap') || {}).textContent === 'Select at least one instrument to begin comparison.');
    eq('empty selection: subtitle cleared', app.byId('master-chart-subtitle').textContent, '');
    app.setChecked(['Gold', 'WTI Crude']);
    app.run('updateMasterChart()');
    check('re-selecting restores a live chart', app.liveChart('master-canvas') !== null);
    eq('re-selecting restores canvas display', app.byId('master-canvas').style.display, '');
    check('re-selecting removes the message element', msgOf(app, 'master-canvas-wrap') === null);
    check('re-selecting restores event subtitle', app.byId('master-chart-subtitle').textContent.startsWith('EVENT: Linear Event'));

    // b) event with no eligible series, then a valid event
    app = await mainApp();
    app.click(app.all('.event-btn')[3]);           // 2001: before all fixture data
    app.flush();
    check('no-eligible event: master chart absent', app.liveChart('master-canvas') === null);
    check('no-eligible event: barometer chart absent', app.liveChart('barometer-canvas') === null);
    eq('no-eligible event: both canvases hidden', [app.byId('master-canvas').style.display, app.byId('barometer-canvas').style.display], ['none', 'none']);
    check('no-eligible event: master message names the event date', (msgOf(app, 'master-canvas-wrap') || { textContent: '' }).textContent.includes('No eligible commodity series for event 2001-01-01'));
    check('no-eligible event: barometer message explains the missing baseline', (msgOf(app, 'barometer-canvas-wrap') || { textContent: '' }).textContent.includes('No pre-event baseline'));
    app.click(app.all('.event-btn')[0]);
    app.flush();
    check('valid event afterwards: both charts live again', app.liveChart('master-canvas') !== null && app.liveChart('barometer-canvas') !== null);
    eq('valid event afterwards: canvases visible', [app.byId('master-canvas').style.display, app.byId('barometer-canvas').style.display], ['', '']);
    check('valid event afterwards: message elements removed', msgOf(app, 'master-canvas-wrap') === null && msgOf(app, 'barometer-canvas-wrap') === null);
    check('valid event afterwards: panel rebuilt', app.panelHtml().includes('EVENT AUDIT'));

    // c) snapshot mode: a window with no data, then a wider window
    const old = { labels: weekdays('2025-12-01', 25), prices: weekdays('2025-12-01', 25).map((_, i) => 100 + i) };
    app = await loadApp({ commodities: { Gold: old, 'WTI Crude': old }, events: [], now: '2026-03-15T12:00:00Z' });
    check('precondition: 5Y master window has data', app.liveChart('master-canvas') !== null);
    app.click('master-tf-1W');
    check('empty 1W window: master chart absent', app.liveChart('master-canvas') === null);
    eq('empty 1W window: canvas hidden', app.byId('master-canvas').style.display, 'none');
    check('empty 1W window: message reports latest available date',
        (msgOf(app, 'master-canvas-wrap') || { textContent: '' }).textContent.includes('Latest available: 2026-01-02'));
    app.click('baro-tf-1W');
    check('empty barometer window: message reports latest available date',
        (msgOf(app, 'barometer-canvas-wrap') || { textContent: '' }).textContent.includes('latest available: 2026-01-02'));
    app.click('master-tf-5Y');
    app.click('baro-tf-1Y');
    check('wider window restores both charts', app.liveChart('master-canvas') !== null && app.liveChart('barometer-canvas') !== null);
    eq('wider window restores canvases', [app.byId('master-canvas').style.display, app.byId('barometer-canvas').style.display], ['', '']);
    check('wider window removes messages', msgOf(app, 'master-canvas-wrap') === null && msgOf(app, 'barometer-canvas-wrap') === null);
});

section('13. Deferred panel update must not outlive Latest Snapshot', async () => {
    const app = await mainApp();
    app.click(app.all('.event-btn')[0]);   // schedules the 50 ms impact/sector refresh
    app.click('today-btn');                // user returns to snapshot before it fires
    app.flush();                           // the deferred refresh fires now
    check('state is snapshot', app.state().active === false);
    evidence('D8 panel after reset+flush', app.panelHtml().replace(/\s+/g, ' ').slice(0, 160));
    evidence('D8 sector header after reset+flush', textOf(app.byId('sector-flow-container')).replace(/\s+/g, ' ').slice(0, 120));
    check('impact panel still shows the snapshot placeholder', app.panelHtml().includes('LATEST SNAPSHOT ACTIVE'), 'D8');
    const sectorText = textOf(app.byId('sector-flow-container'));
    check('sector panel still shows trailing (snapshot) returns, not the event backtest',
        sectorText.includes('TRAILING PRICE RETURNS') && !sectorText.includes('RETROSPECTIVE PRICE IMPACT'), 'D8');

    // Two quick selections: the last one wins
    const app2 = await mainApp();
    app2.click(app2.all('.event-btn')[0]);
    app2.click(app2.all('.event-btn')[2]);
    app2.flush();
    check('rapid A then B: panel shows B', app2.panelHtml().includes('Archive: <code>2015-06-01</code>'));
});

// ============================================================
// REPAIR REGRESSION COVERAGE (D1, D2, D3, D4, D8)
// Added after the D1-D4/D8 repair checkpoint. These drive the real production
// handlers and read the real rendered panels; no application logic is duplicated.
// ============================================================

const boxText = (b) => b ? `${b.name} | ${b.stats}` : 'null';
const noBadTokens = (html) => !/Infinity|NaN|undefined|-100\.00%/.test(html);

section('14a. Undefined endpoint: panels keep rendering, value is unavailable', async () => {
    const app = await loadApp({ commodities: { Gold: b9(p => { p[23] = undefined; }), 'WTI Crude': B9_WTI }, events: [EVENTS_MAIN[0]] });
    app.click(app.all('.event-btn')[0]);
    app.flush();
    check('no uncaught deferred exception', app.takeTimerErrors().length === 0, 'D2');
    const html = app.panelHtml();
    const rows = parseAudit(html);
    check('both instruments rendered', 'Gold' in rows && 'WTI Crude' in rows, 'D2');
    check('panel has no Infinity/NaN/undefined/-100.00%', noBadTokens(html), 'D2');
    if (rows.Gold) eq('Gold T+22 (undefined endpoint) is N/A', rows.Gold.cells[2], 'N/A');
    check('Gold T+22 tooltip gives a concise reason', !!rows.Gold && /unavailable \(price missing or invalid\)/.test(rows.Gold.titles[2] || ''), 'D2');
    check('Gold horizon cell says N/A with reason', /N\/A \(price missing or invalid\)/.test(stripTags(html)), 'D2');
    const boxes = parseBoxes(html);
    check('winner is the only valid instrument (WTI Crude)', boxes.winner && boxes.winner.name === 'WTI CRUDE' && hasNumericHorizonReturn(boxes.winner.stats, '1M'), 'D3');
    check('loser card is unavailable (one eligible instrument)', boxes.loser && boxes.loser.name === 'N/A' && !hasNumericHorizonReturn(boxes.loser.stats, '1M'), 'D3');
    check('ranking note discloses eligible-only ranking', /Ranking covers 1 of 2 instruments/.test(stripTags(html)) && /Not ranked: Gold/.test(stripTags(html)), 'D3');
    check('sector panel still rendered', textOf(app.byId('sector-flow-container')).includes('RETROSPECTIVE PRICE IMPACT'), 'D2');
});

section('14b. Non-finite / non-numeric values in baseline and endpoint paths', async () => {
    const variants = [['null', null], ['undefined', undefined], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['numeric string', '123']];
    for (const [name, v] of variants) {
        // Endpoint (Gold prices[23] is the 1M endpoint for 2015-01-05)
        const e = await loadApp({ commodities: { Gold: b9(p => { p[23] = v; }), 'WTI Crude': B9_WTI }, events: [EVENTS_MAIN[0]] });
        e.run("selectBarometerCommodity('Gold')");
        e.click(e.all('.event-btn')[0]);
        e.flush();
        check(`endpoint ${name}: no uncaught exception`, e.takeTimerErrors().length === 0, 'D2');
        check(`endpoint ${name}: panel has no Infinity/NaN/undefined/-100%`, noBadTokens(e.panelHtml()), name === 'Infinity' || name === '-Infinity' ? 'D1' : 'D2');
        const g = parseAudit(e.panelHtml()).Gold;
        check(`endpoint ${name}: Gold T+22 is N/A, WTI still rendered`, !!g && g.cells[2] === 'N/A' && 'WTI Crude' in parseAudit(e.panelHtml()), 'D1');
        const md = e.liveChart('master-canvas').config.data.datasets[0].data;
        check(`endpoint ${name}: master chart points finite or null`, md.every(x => x === null || Number.isFinite(x)), 'D1');
        const bd = e.liveChart('barometer-canvas').config.data.datasets[0].data;
        check(`endpoint ${name}: barometer points finite or null`, bd.every(x => x === null || Number.isFinite(x)), 'D1');

        // Baseline (Gold prices[1] = close before 2015-01-05)
        const b = await loadApp({ commodities: { Gold: b9(p => { p[1] = v; }), 'WTI Crude': B9_WTI }, events: [EVENTS_MAIN[0]] });
        b.click(b.all('.event-btn')[0]);
        b.flush();
        check(`baseline ${name}: no uncaught exception`, b.takeTimerErrors().length === 0, 'D1');
        check(`baseline ${name}: panel has no Infinity/NaN/undefined/-100%`, noBadTokens(b.panelHtml()), 'D1');
        const br = parseAudit(b.panelHtml());
        // CHANGED (requirement B). Old expectation: Gold excluded and named in the excluded note. New: the invalid nearest
        // price is searched past; the latest finite earlier price (2015-01-01 @ 100, 4 days before the event) is the baseline.
        check(`baseline ${name}: earlier finite price 2015-01-01 @ $100.00 is used, Gold and WTI both rendered, nothing invalid shown`,
            'Gold' in br && 'WTI Crude' in br && br.Gold.base === '$100.00' && noBadTokens(b.panelHtml()), 'D1');
        const mm = b.liveChart('master-canvas').config.data.datasets;
        check(`baseline ${name}: master chart has no non-finite points`, mm.every(d => d.data.every(x => x === null || Number.isFinite(x))), 'D1');
    }

    // Sector backtest (D4): invalid baseline hits only that sector; invalid endpoint only that horizon
    const base = sectorSeries();
    const badBase = base.map((r, i) => (i === 1 ? { x: r.x, y: Infinity } : r));
    const badEnd = base.map((r, i) => (i === 6 ? { x: r.x, y: NaN } : r)); // T+5 from baseline idx 1
    const s = await loadApp({ events: [EVENTS_MAIN[0]], sectors: { XLK: badBase, XLF: base, XLE: badEnd } });
    s.click(s.all('.event-btn')[0]);
    s.flush();
    check('sector: no uncaught exception', s.takeTimerErrors().length === 0, 'D4');
    const rowOf = (label) => { const r = s.byId('sector-flow-container').children.find(c => c._html.includes(label)); return r ? stripTags(r._html) : ''; };
    const pick = (txt, l) => { const m = new RegExp(`${l}:\\s*(\\S+)`).exec(txt); return m ? m[1] : null; };
    const xlk = rowOf('TECHNOLOGY (XLK)'), xlf = rowOf('FINANCIALS (XLF)'), xle = rowOf('ENERGY (XLE)');
    // CHANGED (requirement B). Old expectation: invalid nearest baseline => every horizon N/A. New: the sector uses the
    // same policy as the charts and searches past it to idx 0 (50, 4 days before the event): 1W = 55/50, 1M = 72/50.
    eq('sector: invalid nearest baseline is searched past (same policy as charts): 1W/1M from the earlier baseline', [pick(xlk, '1W'), pick(xlk, '1M')], ['10.00%', '44.00%'], 'D4');
    const s2 = await loadApp({ events: [EVENTS_MAIN[0]], sectors: { XLK: base.map((r, i) => (i <= 1 ? { x: r.x, y: i === 0 ? null : Infinity } : r)), XLF: base } });
    s2.click(s2.all('.event-btn')[0]);
    s2.flush();
    const xlk2 = (s2.byId('sector-flow-container').children.find(c => c._html.includes('TECHNOLOGY (XLK)')) || { _html: '' });
    check('sector: no usable baseline at all => every horizon of that sector is N/A, row kept with reason, other sector unaffected',
        ['1D', '1W', '1M', '1Y'].every(h => pick(stripTags(xlk2._html), h) === 'N/A') && /no valid pre-event price/.test(xlk2.title || '') &&
        (() => { const r = s2.byId('sector-flow-container').children.find(c => c._html.includes('FINANCIALS (XLF)')); return !!r && pick(stripTags(r._html), '1W') === '9.80%'; })(), 'D4');
    check('sector: valid sector beside it is unaffected', pick(xlf, '1W') === '9.80%' && pick(xlf, '1M') === '43.14%', 'D4');
    check('sector: invalid endpoint only blanks its own horizon', pick(xle, '1W') === 'N/A' && pick(xle, '1D') !== 'N/A' && pick(xle, '1M') === '43.14%', 'D4');
    check('sector panel has no Infinity/NaN/-100%', noBadTokens(s.byId('sector-flow-container')._html + xlk + xlf + xle), 'D4');

    // Commodity part of the backtest: invalid endpoint / baseline in Gold
    const c = await loadApp({ commodities: { Gold: b9(p => { p[6] = Infinity; p[23] = null; }), 'WTI Crude': B9_WTI }, events: [EVENTS_MAIN[0]] });
    c.click(c.all('.event-btn')[0]);
    c.flush();
    const goldRow = stripTags((c.byId('sector-flow-container').children.find(r => r._html.includes('GOLD')) || { _html: '' })._html);
    check('commodity backtest row: invalid T+5 and T+22 are N/A, T+1 valid', pick(goldRow, '1W') === 'N/A' && pick(goldRow, '1M') === 'N/A' && pick(goldRow, '1D') !== 'N/A' && noBadTokens(goldRow), 'D4');
});

section('14c. Incomplete / ineligible instruments are never ranked as completed', async () => {
    // Gold complete, WTI complete, Silver truncated (incomplete), Copper invalid endpoint
    const silver = linear('2015-01-01', 15, 10);
    const copper = b9(p => { p[23] = NaN; });
    const app = await loadApp({
        commodities: { Gold: { labels: B9_BASE, prices: B9_BASE.map((_, i) => 100 + i) }, 'WTI Crude': B9_WTI, Silver: silver, Copper: copper },
        events: [EVENTS_MAIN[0]]
    });
    app.click(app.all('.event-btn')[0]);
    app.flush();
    const html = app.panelHtml(), txt = stripTags(html);
    const boxes = parseBoxes(html);
    evidence('D3 mixed eligibility boxes', [boxText(boxes.winner), boxText(boxes.loser)]);
    eq('winner = WTI CRUDE (+43.14%), loser = GOLD among eligible only',
        [boxes.winner && boxes.winner.name, boxes.loser && boxes.loser.name], ['WTI CRUDE', 'GOLD']);
    check('winner/loser show numeric completed 1M returns', boxes.winner && boxes.loser && hasNumericHorizonReturn(boxes.winner.stats, '1M') && hasNumericHorizonReturn(boxes.loser.stats, '1M'), 'D3');
    check('note: ranking covers 2 of 4, names both exclusions',
        /Ranking covers 2 of 4 instruments/.test(txt) && /Silver \(incomplete horizon\)/.test(txt) && /Copper \(endpoint price missing or invalid\)/.test(txt), 'D3');
    const rows = parseAudit(html);
    check('Silver row present with INCOMPLETE horizon status, not a percentage', /Silver\s*\$?[\d.]+.*INCOMPLETE \(\d+\/22 obs to 2015-01-21\)/.test(txt), 'D3');
    check('partial Silver return is not labelled as a completed 1M return anywhere', !/Silver[^|]*1M RETURN/.test(txt) && !!rows.Silver, 'D3');
    check('no Infinity/NaN/undefined/-100%', noBadTokens(html), 'D3');

    // Nobody eligible: both complete-horizon series have an invalid endpoint
    const none = await loadApp({ commodities: { Gold: b9(p => { p[23] = null; }), 'WTI Crude': b9(p => { p[23] = undefined; }) }, events: [EVENTS_MAIN[0]] });
    none.click(none.all('.event-btn')[0]);
    none.flush();
    const nb = parseBoxes(none.panelHtml());
    check('none eligible: both cards unavailable, no numeric return',
        nb.winner && nb.loser && nb.winner.name === 'N/A' && nb.loser.name === 'N/A' &&
        !hasNumericHorizonReturn(nb.winner.stats, '1M') && !hasNumericHorizonReturn(nb.loser.stats, '1M'), 'D3');
    check('none eligible: explanation present and panel otherwise rendered',
        /Ranking unavailable: no instrument has a completed 1M horizon/.test(stripTags(none.panelHtml())) && 'Gold' in parseAudit(none.panelHtml()) && noBadTokens(none.panelHtml()), 'D3');
    check('none eligible: sector panel still rendered', textOf(none.byId('sector-flow-container')).includes('RETROSPECTIVE PRICE IMPACT'), 'D2');

    // No forward observations: explicit status, not +0.00%
    const nf = await loadApp({ commodities: { Gold: linear('2015-01-01', 15, 100), 'WTI Crude': linear('2015-01-01', 15, 50) }, events: [{ name: 'Beyond Data', date: '2015-01-23' }] }); // CHANGED (requirement B): was 2030-01-01, see section 11
    nf.click(nf.all('.event-btn')[0]);
    nf.flush();
    check('no forward data: status reads NO FORWARD DATA and no +0.00% anywhere', /NO FORWARD DATA/.test(stripTags(nf.panelHtml())) && !/\+0\.00%/.test(nf.panelHtml()), 'D3');

    // Horizon change re-evaluates eligibility with the same panels
    const hz = await loadApp({ commodities: { Gold: { labels: B9_BASE, prices: B9_BASE.map((_, i) => 100 + i) }, 'WTI Crude': B9_WTI }, events: [EVENTS_MAIN[0]] });
    hz.click(hz.all('.event-btn')[0]);
    hz.flush();
    hz.click('master-tf-5Y');
    const hb = parseBoxes(hz.panelHtml());
    check('60 observations, 5Y selected: cards unavailable and 5Y incompleteness disclosed',
        hb.winner && hb.winner.name === 'N/A' && !hasNumericHorizonReturn(hb.winner.stats, '5Y') && /INCOMPLETE/.test(stripTags(hz.panelHtml())), 'D3');
});

section('14d. Rapid event changes: only the most recent action is reflected', async () => {
    for (const ignoreClear of [false, true]) {
        const mode = ignoreClear ? 'guard only (clearTimeout ignored)' : 'cancel + guard';
        const fresh = () => mainApp({ ignoreClearTimeout: ignoreClear });
        const snapshotOk = (app, tag) => {
            check(`${mode} ${tag}: state is snapshot and inactive`, app.state().active === false && app.run('activeEventMode') === false, 'D8');
            check(`${mode} ${tag}: impact panel is the snapshot placeholder`, app.panelHtml().includes('LATEST SNAPSHOT ACTIVE'), 'D8');
            const st = textOf(app.byId('sector-flow-container'));
            check(`${mode} ${tag}: sector panel is the snapshot view`, st.includes('TRAILING PRICE RETURNS') && !st.includes('RETROSPECTIVE PRICE IMPACT'), 'D8');
            check(`${mode} ${tag}: today-btn active, no event button active, dropdown = snapshot`,
                app.byId('today-btn')._classes.has('active') && app.all('.event-btn').every(b => !b._classes.has('active')) && app.byId('fx-event-select').value === 'snapshot', 'D8');
        };
        const eventOk = (app, idx, tag) => {
            check(`${mode} ${tag}: state points at event ${idx}`, app.state().active === true && app.state().eventIdx === idx, 'D8');
            check(`${mode} ${tag}: panel shows event ${idx}`, app.panelHtml().includes(`Archive: <code>${EVENTS_MAIN[idx].date}</code>`), 'D8');
            check(`${mode} ${tag}: sector panel shows event backtest for ${EVENTS_MAIN[idx].date}`,
                textOf(app.byId('sector-flow-container')).includes(`strictly before ${EVENTS_MAIN[idx].date}`), 'D8');
            check(`${mode} ${tag}: active flags match`, app.all('.event-btn').map(b => b._classes.has('active')).join() === EVENTS_MAIN.map((_, i) => i === idx).join() && app.byId('fx-event-select').value === String(idx), 'D8');
        };

        // Event A then immediately Latest Snapshot
        let app = await fresh();
        app.click(app.all('.event-btn')[0]);
        app.click('today-btn');
        if (!ignoreClear) eq(`${mode} A->Snapshot: pending timer cancelled`, app.pendingTimers(), 0);
        app.flush();
        snapshotOk(app, 'A->Snapshot');

        // Event A then immediately Event B (via both entry points)
        app = await fresh();
        app.click(app.all('.event-btn')[0]);
        app.click(app.all('.event-btn')[2]);
        if (!ignoreClear) eq(`${mode} A->B: exactly one pending timer`, app.pendingTimers(), 1);
        app.flush();
        eventOk(app, 2, 'A->B');
        app.change('fx-event-select', '0');
        app.change('fx-event-select', '1');
        app.flush();
        eventOk(app, 1, 'dropdown 0->1');

        // Rapid repeated selections ending on an event
        app = await fresh();
        [0, 1, 2, 0, 2, 1].forEach(i => app.click(app.all('.event-btn')[i]));
        if (!ignoreClear) eq(`${mode} repeated: exactly one pending timer`, app.pendingTimers(), 1);
        app.flush();
        eventOk(app, 1, 'repeated (ends on 1)');

        // Rapid repeated selections ending on Latest Snapshot
        app = await fresh();
        [0, 2, 1].forEach(i => app.click(app.all('.event-btn')[i]));
        app.click('today-btn');
        app.flush();
        snapshotOk(app, 'repeated->Snapshot');

        // Snapshot then event again after a stale selection: later action wins over earlier reset
        app = await fresh();
        app.click(app.all('.event-btn')[0]);
        app.click('today-btn');
        app.click(app.all('.event-btn')[2]);
        app.flush();
        eventOk(app, 2, 'A->Snapshot->C');
        check(`${mode} no uncaught deferred exception`, app.takeTimerErrors().length === 0, 'D8');
    }
});

// ============================================================
// EVENT-WINDOW INTEGRITY COVERAGE (D5, D6, D7, baseline age, positive-baseline rule)
// Added by the D5/D6/D7 checkpoint. Production functions and handlers only.
// ============================================================

function horizonCells(html) {
    const out = {};
    html.split('<tr').slice(1).forEach(chunk => {
        const tds = Array.from(chunk.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)).map(m => m[1]);
        if (tds.length >= 7) out[stripTags(tds[0])] = stripTags(tds[6]);
    });
    return out;
}
const upTo = (start, n, end) => weekdays(start, n).filter(d => d <= end);
const serFrom = (labels, base = 100) => ({ labels, prices: labels.map((_, i) => base + i) });
const clone = (x) => JSON.parse(JSON.stringify(x));

section('15a. Series integrity: unsorted pairs, length mismatch, invalid and duplicate dates (D5/D6)', async () => {
    const app = await mainApp();

    // Unsorted date/price pairs stay paired; sources are not mutated
    const L = ['2020-01-07', '2020-01-03', '2020-01-06', '2020-01-02', '2020-01-08'];
    const P = [107, 103, 106, 102, 108];
    const Lc = clone(L), Pc = clone(P);
    const u = slice(L, P, '2020-01-06', '1W', app);
    eq('unsorted: baseline is the latest earlier date with ITS OWN price (2020-01-03 @ 103)', [u.noData, u.baselineDate, u.baselinePrice], [false, '2020-01-03', 103], 'D5');
    eq('unsorted: window is chronological with prices still paired to their dates',
        u.labels.map((d, i) => `${d}:${u.prices[i]}`), ['2020-01-02:102', '2020-01-03:103', '2020-01-06:106', '2020-01-07:107', '2020-01-08:108'], 'D5');
    eq('unsorted: source arrays not mutated', [L, P], [Lc, Pc], 'D5');
    eq('unsorted: first session and endpoint', [u.firstSessionDate, u.endDate, u.endpointDate, u.endpointPrice], ['2020-01-06', '2020-01-08', '2020-01-08', 108], 'D5');

    // Length mismatch in both directions
    const mm1 = slice(weekdays('2020-01-01', 8), [1, 2, 3, 4, 5, 6], '2020-01-03', '1W', app);
    const mm2 = slice(weekdays('2020-01-01', 6), [1, 2, 3, 4, 5, 6, 7, 8], '2020-01-03', '1W', app);
    [['more labels than prices', mm1], ['more prices than labels', mm2]].forEach(([n, r]) => {
        check(`${n}: series unavailable, flagged invalid, reason says lengths differ`, r.noData === true && r.seriesInvalid === true && /different lengths/.test(r.reason || ''), 'D6');
        eq(`${n}: no labels or prices leak out`, [r.labels, r.prices, r.baselinePrice], [[], [], null], 'D6');
    });

    // Invalid calendar dates (and non-strings) make the series unavailable
    ['2020-02-30', '2020-13-01', '2019-02-29', '2020/01/03', '2020-1-3', '', null, 20200103].forEach(bad => {
        const r = slice(['2020-01-01', bad, '2020-01-06'], [1, 2, 3], '2020-01-06', '1W', app);
        check(`invalid date ${JSON.stringify(bad)}: series unavailable with reason`, r.noData === true && r.seriesInvalid === true && /invalid calendar date/.test(r.reason || ''));
    });
    const leap = slice(['2020-02-28', '2020-02-29', '2020-03-02'], [1, 2, 3], '2020-03-01', '1W', app);
    eq('2020-02-29 is a real date and is the baseline', [leap.noData, leap.baselineDate], [false, '2020-02-29']);

    // Duplicate dates are ambiguous: never silently pick one
    [[1, 2], [5, 5]].forEach(([p1, p2]) => {
        const r = slice(['2020-01-02', '2020-01-03', '2020-01-03', '2020-01-06'], [1, p1, p2, 4], '2020-01-06', '1W', app);
        check(`duplicate date with prices ${p1}/${p2}: series unavailable, reason names the date`, r.noData === true && r.seriesInvalid === true && /duplicate date 2020-01-03/.test(r.reason || ''));
    });

    // Invalid-price records remain as gaps and never shift endpoint offsets
    const days = weekdays('2020-01-01', 30);
    const clean = slice(days, days.map((_, i) => 100 + i), '2020-01-10', '1W', app);
    const gappy = slice(days, days.map((_, i) => (i === clean.baselineRawIdx + 3 ? null : 100 + i)), '2020-01-10', '1W', app);
    eq('gap inside the window: endpoint date and price identical to the gap-free series', [gappy.endDate, gappy.endpointPrice, gappy.actualPostEventObs], [clean.endDate, clean.endpointPrice, clean.actualPostEventObs]);
    check('gap inside the window: the gap keeps its date with a null price', gappy.prices[gappy.labels.indexOf(days[clean.baselineRawIdx + 3])] === null);
    const badEnd = slice(days, days.map((_, i) => (i === clean.baselineRawIdx + 5 ? NaN : 100 + i)), '2020-01-10', '1W', app);
    eq('invalid endpoint: endpoint date is still T+5 (no earlier price substituted), unusable', [badEnd.endpointDate, badEnd.endpointUsable, badEnd.endpointReason], [clean.endpointDate, false, 'price missing or invalid']);
});

section('15b. A malformed series cannot block valid instruments (UI)', async () => {
    const good = { labels: B9_BASE, prices: B9_BASE.map((_, i) => 50 + i) };
    const dupGold = { labels: B9_BASE.map((d, i) => (i === 10 ? B9_BASE[9] : d)), prices: B9_BASE.map((_, i) => 100 + i) };
    const app = await loadApp({ commodities: { Gold: dupGold, 'WTI Crude': good }, events: [EVENTS_MAIN[0]], sectors: { XLK: sectorSeries() } });
    app.run("selectBarometerCommodity('Gold')");
    app.click(app.all('.event-btn')[0]);
    app.flush();
    check('no uncaught exception', app.takeTimerErrors().length === 0);
    const html = app.panelHtml(), rows = parseAudit(html);
    check('WTI Crude still rendered, Gold not in the table', 'WTI Crude' in rows && !('Gold' in rows));
    check('Gold named as excluded with the duplicate-date reason', /Excluded \(no usable baseline\): Gold \(series invalid: duplicate date/.test(stripTags(html)));
    const mc = app.liveChart('master-canvas');
    check('master chart shows WTI data and lists Gold as excluded', mc && mc.config.data.datasets.some(d => d.label.startsWith('WTI Crude') && d.data.some(v => v !== null)) && mc.config.data.datasets.some(d => d.label.startsWith('Gold (Excluded:')));
    check('barometer for the malformed series shows a message instead of a chart', app.liveChart('barometer-canvas') === null);
    check('sector panel still rendered; malformed Gold row is N/A with a reason',
        textOf(app.byId('sector-flow-container')).includes('TECHNOLOGY (XLK)') &&
        (app.byId('sector-flow-container').children.find(c => c._html.includes('GOLD')) || { title: '' }).title.includes('series invalid'));

    // Sorted vs shuffled input: identical chart and table
    const order = B9_BASE.map((_, i) => i).reverse();
    const shuffledGold = { labels: order.map(i => B9_BASE[i]), prices: order.map(i => 100 + i) };
    const a = await loadApp({ commodities: { Gold: { labels: B9_BASE, prices: B9_BASE.map((_, i) => 100 + i) }, 'WTI Crude': good }, events: [EVENTS_MAIN[0]] });
    const b = await loadApp({ commodities: { Gold: shuffledGold, 'WTI Crude': good }, events: [EVENTS_MAIN[0]] });
    [a, b].forEach(x => { x.click(x.all('.event-btn')[0]); x.flush(); });
    eq('reverse-ordered Gold produces the same master chart data', b.liveChart('master-canvas').config.data.datasets.map(d => d.data), a.liveChart('master-canvas').config.data.datasets.map(d => d.data), 'D5');
    eq('reverse-ordered Gold produces the same audit table', parseAudit(b.panelHtml()), parseAudit(a.panelHtml()), 'D5');
});

section('15c. Baseline selection: search past invalid prices, 7-day limit, no usable baseline', async () => {
    const app = await mainApp();
    const L = ['2020-01-02', '2020-01-08', '2020-01-20', '2020-01-21'];
    const P = [1, 2, 3, 4];
    const ok7 = slice(L, P, '2020-01-15', '1W', app);
    eq('baseline exactly 7 calendar days old is allowed', [ok7.noData, ok7.baselineDate, ok7.baselineAgeDays], [false, '2020-01-08', 7]);
    const old8 = slice(L, P, '2020-01-16', '1W', app);
    eq('baseline 8 calendar days old is unavailable; candidate and age exposed', [old8.noData, old8.baselineDate, old8.baselinePrice, old8.baselineCandidateDate, old8.baselineCandidateAgeDays], [true, null, null, '2020-01-08', 8]);
    check('unavailable baseline yields no window and no return basis', old8.labels.length === 0 && old8.returnsAvailable === false);
    check('reason states date, age and limit', /2020-01-08, 8 days before the event \(limit 7 calendar days\)/.test(old8.reason || ''));

    // Invalid nearest price, usable earlier baseline (and boundary ages through an invalid record)
    const d = weekdays('2020-01-01', 10);
    const skip = slice(d, [1, 2, 3, null, NaN, 6, 7, 8, 9, 10], '2020-01-08', '1W', app);
    eq('two invalid records before the event: baseline is the earlier finite one', [skip.baselineDate, skip.baselinePrice, skip.baselineSkipped, skip.baselineAgeDays], ['2020-01-03', 3, 2, 5]);
    const skipOld = slice(['2019-12-25', '2020-01-06', '2020-01-07'], [1, NaN, 3], '2020-01-07', '1W', app);
    eq('search past an invalid record into a stale one: unavailable (no return from a stale price)', [skipOld.noData, skipOld.baselineCandidateDate, skipOld.baselineCandidateAgeDays], [true, '2019-12-25', 13]);
    check('no pre-event observation at all is still reported as such', slice(L, P, '2020-01-02', '1W', app).incompleteReason === 'Baseline unavailable');
    const invalidEvent = slice(L, P, '2020-02-30', '1W', app);
    check('impossible event date: explicit noData', invalidEvent.noData === true && /Invalid event date/.test(invalidEvent.reason || ''));
    eq('date-only semantics: event on a weekend uses the prior record (age 1)', (() => { const r = slice(weekdays('2020-01-01', 10), weekdays('2020-01-01', 10).map((_, i) => 10 + i), '2020-01-04', '1W', app); return [r.baselineDate, r.baselineAgeDays]; })(), ['2020-01-03', 1]);

    // Through the UI: age 7 vs 8 (Gold), everything else normal
    const dense = weekdays('2015-01-05', 6);           // 01-05..01-12
    const resume = weekdays('2015-01-20', 40);
    const goldSeries = serFrom(dense.concat(resume));
    const mk = async (date) => {
        const a = await loadApp({ commodities: { Gold: goldSeries, 'WTI Crude': B9_WTI }, events: [{ name: 'Age Event', date }] });
        a.click(a.all('.event-btn')[0]);
        a.flush();
        return a;
    };
    const u7 = await mk('2015-01-19'); // baseline 2015-01-12, 7 days
    const r7 = parseAudit(u7.panelHtml());
    check('UI age 7: Gold has a baseline and appears in the audit table', 'Gold' in r7, undefined);
    check('UI age 7: BASE tooltip states date and age', /Baseline 2015-01-12: 7 day\(s\) before the event/.test(u7.panelHtml()));
    const u8 = await mk('2015-01-20'); // baseline 2015-01-12, 8 days
    const r8 = parseAudit(u8.panelHtml());
    check('UI age 8: Gold is excluded, not in the table', !('Gold' in r8) && 'WTI Crude' in r8);
    check('UI age 8: note names the candidate date, age and limit, no return shown for it',
        /Excluded \(no usable baseline\): Gold \(baseline too old: latest usable price 2015-01-12 is 8 days before event \(limit 7\)\)/.test(stripTags(u8.panelHtml())));
    check('UI age 8: master legend also states the reason', u8.liveChart('master-canvas').config.data.datasets.some(d => /^Gold \(Excluded: Latest usable pre-event price is 2015-01-12, 8 days/.test(d.label)));
    check('UI age 8: sector/commodity backtest row for Gold is N/A with the same reason',
        (() => { const r = u8.byId('sector-flow-container').children.find(c => c._html.includes('GOLD')); return !!r && /baseline too old/.test(r.title || '') && !/%/.test(stripTags(r._html)); })());

    // A Lumber-like stale series against a recent event
    const recent = linear('2026-01-01', 200, 100);
    const lum = await loadApp({ commodities: { Gold: recent, 'WTI Crude': recent, Lumber: { labels: ['2023-04-10'], prices: [380.6] } }, events: [{ name: 'Recent', date: '2026-02-28' }] });
    lum.click(lum.all('.event-btn')[0]);
    lum.flush();
    const lt = stripTags(lum.panelHtml());
    check('stale single-observation series is excluded with its candidate date', /Lumber \(baseline too old: latest usable price 2023-04-10 is \d+ days before event \(limit 7\)\)/.test(lt) && !('Lumber' in parseAudit(lum.panelHtml())));
});

section('15d. Zero and negative baselines, negative endpoints', async () => {
    const app = await mainApp();
    const d = weekdays('2020-01-01', 12);
    [0, -5].forEach(b => {
        const r = slice(d, [10, 11, b, 13, 14, 15, 16, 17, 18, 19, 20, 21], '2020-01-06', '1W', app);
        eq(`baseline ${b}: selected as-is (not searched past), raw window kept, returns unavailable`, [r.noData, r.baselineDate, r.baselinePrice, r.returnsAvailable], [false, '2020-01-03', b, false]);
        check(`baseline ${b}: reason requires a strictly positive baseline`, /strictly positive baseline/.test(r.returnsReason || ''));
        check(`baseline ${b}: prices stay available for raw display`, r.prices.includes(b) && r.prices.every(v => v === null || Number.isFinite(v)));
    });
    const pos = slice(d, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], '2020-01-06', '1W', app);
    eq('positive baseline: returns available', [pos.returnsAvailable, pos.returnsReason], [true, null]);

    // UI, negative baseline in Gold (p[1] = -5): excluded from percentage views, raw barometer kept
    const neg = await loadApp({ commodities: { Gold: b9(p => { p[1] = -5; }), 'WTI Crude': B9_WTI }, events: [EVENTS_MAIN[0]] });
    neg.run("selectBarometerCommodity('Gold')");
    neg.click(neg.all('.event-btn')[0]);
    neg.flush();
    check('negative baseline: no uncaught exception', neg.takeTimerErrors().length === 0);
    const nhtml = neg.panelHtml(), nrows = parseAudit(nhtml);
    check('negative baseline: Gold not in the table or ranking, WTI kept', !('Gold' in nrows) && 'WTI Crude' in nrows && noBadTokens(nhtml));
    check('negative baseline: excluded note states the percentage reason', /Gold \(percentage returns unavailable: baseline -5 on 2015-01-02 is not strictly positive\)/.test(stripTags(nhtml)));
    check('negative baseline: master legend lists Gold as excluded with the reason', neg.liveChart('master-canvas').config.data.datasets.some(d => /^Gold \(Excluded: Percentage returns unavailable/.test(d.label)));
    const bc = neg.liveChart('barometer-canvas');
    check('negative baseline: raw-price barometer chart retained with the negative price', !!bc && bc.config.data.datasets[0].data.includes(-5));
    const goldRow = neg.byId('sector-flow-container').children.find(c => c._html.includes('GOLD'));
    check('negative baseline: commodity backtest row is N/A (no percentages)', !!goldRow && !/%/.test(stripTags(goldRow._html)) && /N\/A/.test(stripTags(goldRow._html)));

    // Zero baseline keeps behaving the same way
    const zero = await loadApp({ commodities: { Gold: b9(p => { p[1] = 0; }), 'WTI Crude': B9_WTI }, events: [EVENTS_MAIN[0]] });
    zero.click(zero.all('.event-btn')[0]);
    zero.flush();
    check('zero baseline: excluded with the percentage reason, no bad tokens', !('Gold' in parseAudit(zero.panelHtml())) && /baseline 0 on 2015-01-02 is not strictly positive/.test(stripTags(zero.panelHtml())) && noBadTokens(zero.panelHtml()));

    // Positive baseline, negative endpoint: valid arithmetic price change (Gold 1M endpoint = -10 vs 101)
    const ne = await loadApp({ commodities: { Gold: b9(p => { p[23] = -10; }), 'WTI Crude': B9_WTI }, events: [EVENTS_MAIN[0]] });
    ne.click(ne.all('.event-btn')[0]);
    ne.flush();
    const nb = parseBoxes(ne.panelHtml()), nr = parseAudit(ne.panelHtml());
    eq('negative endpoint: Gold 1M cell is (-10-101)/101 = -109.90%', nr.Gold && nr.Gold.cells[2], '-109.90%');
    eq('negative endpoint: Gold is ranked (worst) with that return', nb.loser, { name: 'GOLD', stats: '1M RETURN: -109.90%' });
    check('negative endpoint: card shows the negative price without a malformed "$-"', ne.panelHtml().includes('$101.00 (2015-01-02) → -$10.00 (2015-02-03)'));
    const gd = ne.liveChart('master-canvas').config.data.datasets[0].data;
    check('negative endpoint: master chart plots the -109.9% point', gd.includes(-109.901));
});

section('15e. Event-year end (D7): coverage states, plotting boundary, endpoint validity', async () => {
    const app = await mainApp();
    const EV = '2020-03-10';
    const mk = (end, nullOn) => { const l = upTo('2020-01-01', 320, end); return { labels: l, prices: l.map((d, i) => (d === nullOn ? null : 100 + i)) }; };
    const at = (s) => slice(s.labels, s.prices, EV, 'YTD', app);

    // June stop
    const jun = at(mk('2020-06-30'));
    eq('data stops in June: incomplete, ends at the last observation, not complete', [jun.coverage, jun.horizonStatus, jun.horizonComplete, jun.endDate, jun.boundaryDate], ['incomplete', 'incomplete', false, '2020-06-30', '2020-12-31'], 'D7');
    check('data stops in June: reason names both dates', /2020-06-30/.test(jun.incompleteReason || '') && /2020-12-31/.test(jun.incompleteReason || ''), 'D7');

    // Tolerance edges: 2020-12-24 is exactly 7 days before Dec 31; 2020-12-23 is 8
    const e24 = at(mk('2020-12-24')), e23 = at(mk('2020-12-23'));
    eq('ends 7 days before Dec 31: year-end coverage unverified', [e24.coverage, e24.horizonStatus, e24.horizonComplete], ['unverified', 'unverified', false], 'D7');
    eq('ends 8 days before Dec 31: incomplete', [e23.coverage, e23.horizonStatus], ['incomplete', 'incomplete'], 'D7');
    const e28 = at(mk('2020-12-28'));
    eq('ends 2020-12-28: unverified, endpoint usable but the window is NOT complete', [e28.coverage, e28.endDate, e28.endpointUsable, e28.horizonComplete], ['unverified', '2020-12-28', true, false], 'D7');
    check('unverified reason says the final session cannot be confirmed without a calendar', /cannot be confirmed as the final session/.test(e28.incompleteReason || ''), 'D7');

    // Covered on Dec 31 itself
    const e31 = at(mk('2020-12-31'));
    eq('record on Dec 31: boundary covered, complete, endpoint 2020-12-31 usable', [e31.coverage, e31.horizonStatus, e31.horizonComplete, e31.endDate, e31.endpointUsable], ['covered', 'complete', true, '2020-12-31', true], 'D7');

    // Data extends into the following year: nothing after Dec 31 is plotted
    const nxt = at(mk('2021-02-15'));
    eq('data into the next year: covered, ends 2020-12-31', [nxt.coverage, nxt.endDate, nxt.endpointDate], ['covered', '2020-12-31', '2020-12-31'], 'D7');
    check('no next-year point is plotted', nxt.labels.every(d => d <= '2020-12-31') && nxt.view.labels.some(d => d > '2020-12-31'), 'D7');

    // Coverage vs endpoint validity are separate
    const inv = at(mk('2021-01-15', '2020-12-31'));
    eq('later observations cover the boundary but the Dec 31 price is invalid: covered, endpoint UNUSABLE, no earlier price substituted',
        [inv.coverage, inv.horizonComplete, inv.endpointDate, inv.endpointUsable, inv.endpointReason], ['covered', true, '2020-12-31', false, 'price missing or invalid'], 'D7');
    const stale = (() => { const l = upTo('2020-01-01', 320, '2020-12-10').concat(['2021-01-04']); return at({ labels: l, prices: l.map((_, i) => 100 + i) }); })();
    eq('covered via a January record but the last in-year record is 21 days before Dec 31: endpoint unusable (stale)',
        [stale.coverage, stale.endpointDate, stale.endpointUsable], ['covered', '2020-12-10', false], 'D7');
    check('stale endpoint reason states the limit', /more than 7 days before event-year end 2020-12-31/.test(stale.endpointReason || ''), 'D7');
    const l24 = upTo('2020-01-01', 320, '2020-12-24').concat(['2021-01-04']);
    const s24 = at({ labels: l24, prices: l24.map((_, i) => 100 + i) });
    eq('last in-year record exactly 7 days before Dec 31 is an acceptable endpoint', [s24.endpointDate, s24.endpointUsable], ['2020-12-24', true], 'D7');
    const noFwd = slice(['2019-12-30', '2019-12-31', '2021-01-04'], [1, 2, 3], '2020-01-01', 'YTD', app);
    eq('nothing after the baseline inside the event year: no forward data', [noFwd.horizonStatus, noFwd.actualPostEventObs, noFwd.endDate], ['noforward', 0, '2019-12-31'], 'D7');

    // UI
    const ui = async (gold, wti) => {
        const a = await loadApp({ commodities: { Gold: gold, 'WTI Crude': wti }, events: [{ name: 'Year-end Event', date: EV }] });
        a.click(a.all('.event-btn')[0]);
        a.click('master-tf-YTD');
        a.flush();
        return a;
    };
    const cov = mk('2020-12-31'), jn = mk('2020-06-30'), un = mk('2020-12-28');

    const mixed = await ui(cov, jn);
    const mb = parseBoxes(mixed.panelHtml());
    const mt = stripTags(mixed.panelHtml());
    check('event mode: YTD controls are labelled "Event-year end" on both tabs', ['baro-tf-YTD', 'master-tf-YTD'].every(id => mixed.byId(id).textContent === 'Event-year end'), 'D7');
    check('panel and titles say "Event-year end"', /Horizon: Event-year end/.test(mt) && /Event-year end HORIZON/.test(mt), 'D7');
    check('master subtitle says "Horizon: Event-year end"', mixed.byId('master-chart-subtitle').textContent.includes('Horizon: Event-year end'), 'D7');
    eq('ranking: only the covered instrument (Gold) is eligible, so the loser card is unavailable', [mb.winner && mb.winner.name, mb.loser && mb.loser.name], ['GOLD', 'N/A'], 'D7');
    check('winner card is labelled event-year end', mb.winner && /^EVENT-YEAR END RETURN: \+/.test(mb.winner.stats), 'D7');
    const hc = horizonCells(mixed.panelHtml());
    check('covered row shows a return and dates; incomplete row says INCOMPLETE with its actual end date',
        /^\+[\d.]+% 2020-03-09 → 2020-12-31$/.test(hc.Gold || '') && hc['WTI Crude'] === 'INCOMPLETE (data ends 2020-06-30)', 'D7');
    check('note explains eligibility and that coverage is not a session check', /Ranking covers 1 of 2 instruments/.test(mt) && /WTI Crude \(incomplete horizon\)/.test(mt) && /does not verify every trading session/.test(mt), 'D7');
    const mlegend = mixed.liveChart('master-canvas').config.data.datasets.map(d => d.label);
    check('master legend tags the incomplete series only', mlegend.includes('Gold') && mlegend.includes('WTI Crude [Incomplete]'), 'D7');
    check('master chart plots nothing past December 31', mixed.liveChart('master-canvas').config.data.labels.every(d => d <= '2020-12-31'), 'D7');

    const unv = await ui(un, un);
    const ub = parseBoxes(unv.panelHtml()), uc = horizonCells(unv.panelHtml()), ut = stripTags(unv.panelHtml());
    check('late-December data: year-end UNVERIFIED shown per instrument, nobody ranked',
        uc.Gold === 'YEAR-END UNVERIFIED (data ends 2020-12-28)' && ub.winner.name === 'N/A' && ub.loser.name === 'N/A' && /Ranking unavailable/.test(ut), 'D7');
    check('late-December data: subtitle and legend say unverified, not complete',
        /YEAR-END UNVERIFIED/.test(unv.byId('master-chart-subtitle').textContent) && unv.liveChart('master-canvas').config.data.datasets.every(d => /\[Year-end unverified\]$/.test(d.label)), 'D7');

    // Covered boundary with an invalid Dec 31 price: unavailable, not silently replaced by Dec 30
    const badEnd = await ui(mk('2021-01-15', '2020-12-31'), cov);
    const bh = horizonCells(badEnd.panelHtml());
    check('covered boundary + invalid Dec 31 price: row says N/A with reason and is not ranked',
        bh.Gold === 'N/A (price missing or invalid)' && parseBoxes(badEnd.panelHtml()).winner.name === 'WTI CRUDE', 'D7');
    check('same case: no next-year point plotted in the master chart', badEnd.liveChart('master-canvas').config.data.labels.every(d => d <= '2020-12-31'), 'D7');

    // Latest Snapshot restores the YTD label; horizon remembered
    mixed.click('today-btn');
    check('Latest Snapshot restores the plain YTD label', ['baro-tf-YTD', 'master-tf-YTD'].every(id => mixed.byId(id).textContent === 'YTD'), 'D7');
});

section('15f. Shared baseline policy across chart, audit table and sector returns; observation caveats', async () => {
    // Gold and XLK share dates and prices; their nearest pre-event price (2015-01-02) is invalid.
    const xlk = B9_BASE.map((x, i) => ({ x, y: i === 1 ? null : 100 + i }));
    const app = await loadApp({ commodities: { Gold: b9(p => { p[1] = null; }), 'WTI Crude': B9_WTI }, events: [EVENTS_MAIN[0]], sectors: { XLK: xlk } });
    app.run("selectBarometerCommodity('Gold')");
    app.click(app.all('.event-btn')[0]);
    app.flush();
    check('no uncaught exception', app.takeTimerErrors().length === 0);
    const rows = parseAudit(app.panelHtml());
    eq('audit table baseline is 2015-01-01 @ $100.00 (searched past the invalid 2015-01-02)', rows.Gold.base, '$100.00');
    check('BASE tooltip reports date, age and records searched past', /Baseline 2015-01-01: 4 day\(s\) before the event; 1 invalid record\(s\) searched past/.test(app.panelHtml()));
    eq('shared state baseline date/age equal the table', [app.state().baselineDate, app.state().baselineAgeDays], ['2015-01-01', 4]);
    const mc = app.liveChart('master-canvas');
    const goldDs = mc.config.data.datasets.find(d => d.label.startsWith('Gold'));
    const iB = mc.config.data.labels.indexOf('2015-01-01');
    eq('master chart: Gold baseline marker and 0.000% are on 2015-01-01', [goldDs.pointRadius[iB], goldDs.data[iB]], [5, 0]);
    const bc = app.liveChart('barometer-canvas');
    eq('barometer: baseline marker on 2015-01-01', bc.config.data.datasets[0].pointRadius[bc.config.data.labels.indexOf('2015-01-01')], 5);
    const sectorRow = (label) => stripTags(app.byId('sector-flow-container').children.find(c => c._html.includes(label))._html);
    const pick = (txt, l) => { const m = new RegExp(`${l}:\\s*(\\S+)`).exec(txt); return m ? m[1] : null; };
    eq('audit table T+5 / T+22 (from the shared baseline)', [rows.Gold.cells[1], rows.Gold.cells[2]], ['+5.00%', '+22.00%']);
    eq('sector XLK returns equal the Gold audit-table returns', [pick(sectorRow('TECHNOLOGY (XLK)'), '1W'), pick(sectorRow('TECHNOLOGY (XLK)'), '1M')], ['5.00%', '22.00%']);
    eq('commodity backtest GOLD row equals the audit table too', [pick(sectorRow('GOLD'), '1W'), pick(sectorRow('GOLD'), '1M')], ['5.00%', '22.00%']);

    // Baselines that differ by instrument are disclosed, not hidden behind one date
    const diff = await loadApp({ commodities: { Gold: { labels: B9_BASE, prices: B9_BASE.map((_, i) => 100 + i) }, 'WTI Crude': { labels: B9_BASE.filter((d, i) => i !== 1), prices: B9_BASE.filter((d, i) => i !== 1).map((_, i) => 50 + i) } }, events: [EVENTS_MAIN[0]] });
    diff.click(diff.all('.event-btn')[0]);
    diff.flush();
    check('different baselines per instrument: panel says so and subtitle lists each', /Baseline: varies by instrument/.test(stripTags(diff.panelHtml())) && /Baselines differ by instrument: Gold 2015-01-02, WTI Crude 2015-01-01/.test(diff.byId('master-chart-subtitle').textContent));

    // Observation-based caveats stay visible
    const html = stripTags(app.panelHtml());
    check('footnote: fixed observation counts are approximations, not verified calendar periods', /fixed observation counts \(5\/22\/63\/126\/252\/1260\) over the records present, not verified calendar periods/.test(html));
    check('footnote: baseline threshold is provisional and not a session check', /at most 7 calendar days old \(provisional quality threshold; it does not verify exchange sessions\)/.test(html));
    check('panel header: per-instrument baselines that differ are flagged, not hidden', /Baseline: varies by instrument/.test(html));
    const plain = await mainApp();
    plain.click(plain.all('.event-btn')[0]);
    plain.flush();
    check('panel header: a shared baseline shows its date and age', /Baseline: 2015-01-02 \(latest finite price strictly before event; 3 day\(s\) before event\)/.test(stripTags(plain.panelHtml())));
    check('sector header discloses the baseline rule and limit', textOf(app.byId('sector-flow-container')).includes('at most 7 calendar days old'));
});

// ============================================================
// SNAPSHOT-CALCULATION REPAIR COVERAGE (Latest Snapshot mode)
// Added by the snapshot-calculation checkpoint. All values come from the real
// production functions/handlers (boot -> resetToToday(), today-btn, tf buttons).
// Synthetic fixtures only; expected numbers are hand-derived from the fixtures.
// Convention (PROJECT_CONTEXT.md): price returns need a strictly positive baseline;
// null/undefined/NaN/+-Infinity/numeric strings are unavailable, never 0, -100%,
// Infinity% or NaN%; a valid unchanged price is a real 0.00% (distinct from N/A).
// ============================================================

const SN_N = 300;
const SN_DATES = weekdays('2018-01-01', SN_N);
const snSeries = (fn) => SN_DATES.map((x, i) => ({ x, y: fn(i) }));
// trailing horizons use the latest observation (index 299) and indices 298 / 294 / 277 / 47
const sectorRowsOf = (app) => {
    const out = {};
    app.byId('sector-flow-container').children.forEach(c => {
        if (!/metric-row/.test(c.className)) return;
        const m = /^(.*?)\s+1D:\s*(\S+)\s+1W:\s*(\S+)\s+1M:\s*(\S+)\s+1Y:\s*(\S+)$/.exec(stripTags(c._html));
        if (m) out[m[1]] = { cells: m.slice(2, 6), html: c._html, titles: Array.from(c._html.matchAll(/title="([^"]*)"/g)).map(x => x[1]) };
    });
    return out;
};
const SNAP_BAD_TOKENS = /Infinity|NaN|undefined|-100\.00%/;
const MB_DATES = B9_BASE; // 60 weekdays from 2015-01-01
const MB_NOW = '2015-04-01T12:00:00Z';
const mbSeries = (mut) => { const p = MB_DATES.map((_, i) => 100 + i); if (mut) mut(p); return { labels: MB_DATES, prices: p }; };
const mbApp = (commodities, extra = {}) => loadApp(Object.assign({ commodities, events: EVENTS_MAIN, now: MB_NOW }, extra));
const masterDs = (app, prefix) => app.liveChart('master-canvas').config.data.datasets.find(d => d.label.startsWith(prefix));
const ys = (ds) => ds.data.map(pt => pt.y);

section('16a. toPercentChange / computeSnapshotPercentSeries: validity and unavailable states', async () => {
    const app = await mainApp();
    const pc = app.fn('toPercentChange');
    const detail = app.fn('computeSnapshotPercentSeries');
    const plain = (x) => JSON.parse(JSON.stringify(x)); // strips vm-realm prototypes for eq()

    eq('valid series: percent vs first price, null stays a gap', plain(pc([100, 110, null, 99])), [0, 10, null, -1]);
    eq('null / undefined baseline is skipped to the first VALID price (never coerced)', plain(pc([null, undefined, 100, 110])), [null, null, 0, 10]);
    eq('NaN, +Infinity, -Infinity and numeric strings are gaps; baseline is the first valid price',
        plain(pc([NaN, Infinity, -Infinity, '100', 100, 125])), [null, null, null, null, 0, 25]);
    eq('numeric string is never treated as a price: "100" baseline is not used', plain(pc(['100', 50, 75])), [null, 0, 50]);
    const unchanged = pc([100, 100, 100]);
    eq('valid unchanged price is a real 0.00% return (0, not null)', plain(unchanged), [0, 0, 0]);
    check('unchanged return is +0, not -0 and not null', unchanged.every(v => v === 0 && !Object.is(v, -0)));
    const tinyDown = pc([100000, 99999.9999]);
    check('a rounded-to-zero decline is reported as +0 (no "-0")', tinyDown[1] === 0 && !Object.is(tinyDown[1], -0));

    const z = detail([0, 10, 20]);
    check('zero baseline: unavailable with a reason, NOT skipped to the next price', z.ok === false && /zero/.test(z.reason) && z.pct.every(v => v === null) && z.baselineIdx === 0);
    eq('zero baseline: toPercentChange is all-null (not a flat 0% line, not percentages off 10)', plain(pc([0, 10, 20])), [null, null, null]);
    const n = detail([-5, 10, 20]);
    check('negative baseline: unavailable with a reason, no percentages', n.ok === false && /negative/.test(n.reason) && n.pct.every(v => v === null));
    const nb = detail([null, -5, 10]);
    check('negative FIRST VALID price (earlier records null) is the baseline -> unavailable', nb.ok === false && nb.baselineIdx === 1 && nb.pct.every(v => v === null));
    eq('negative endpoint with a positive baseline is a valid change', plain(pc([100, -50])), [0, -150]);
    const allBad = detail([null, NaN, 'x', undefined]);
    check('no valid price at all: unavailable, all-null (not a flat 0% series)', allBad.ok === false && /no valid price/.test(allBad.reason) && allBad.pct.every(v => v === null) && allBad.pct.length === 4);
    eq('empty input: empty result', plain(pc([])), []);
    eq('non-array input: empty result, no exception', [plain(pc(null)), plain(pc(undefined))], [[], []]);
    const mixed = pc([100, NaN, Infinity, -Infinity, 'x', null, 105]);
    check('no output value is NaN or infinite', mixed.every(v => v === null || Number.isFinite(v)));
    eq('same formula as the event path: computePriceReturn(100, 105)', [plain(pc([100, 105]))[1], app.fn('computePriceReturn')(100, 105).pct], [5, 5]);

    const one = detail([380.6], ['2023-04-10']);
    check('single usable observation is unavailable with the exact disclosure, not a 0% return',
        one.ok === false && one.reason === 'Single observation 2023-04-10; return unavailable.' && one.pct.length === 1 && one.pct[0] === null && one.baselineIdx === 0);
    eq('single observation toPercentChange is all-null (not a measured 0.00%)', plain(pc([380.6])), [null]);
    const oneGap = detail([null, 380.6, NaN], ['2015-01-01', '2015-03-15', '2015-03-16']);
    check('one usable price among invalids is still a single observation at that date',
        oneGap.ok === false && oneGap.reason === 'Single observation 2015-03-15; return unavailable.' && oneGap.pct.every(v => v === null) && oneGap.baselineIdx === 1);
    eq('two valid prices remain a measured series (real 0 at the baseline)', plain(detail([100, 105], ['2015-01-01', '2015-01-02']).pct), [0, 5]);
});

section('16b. Latest Snapshot sector and commodity trailing returns (boot path)', async () => {
    const sectors = {
        XLK:  snSeries(i => 100 + i),                                   // fully valid
        XLE:  snSeries(i => i === 299 ? null : 100 + i),                // latest observation null
        XLF:  snSeries(i => i === 298 ? null : 100 + i),                // 1D baseline null
        XLV:  snSeries(i => i === 299 ? NaN : 100 + i),                 // latest NaN
        XLY:  snSeries(i => i === 294 ? '394' : i === 277 ? Infinity : i === 47 ? -Infinity : 100 + i), // string / +Inf / -Inf baselines
        XLI:  snSeries(i => i === 294 ? 0 : i === 277 ? -377 : 100 + i), // zero 1W baseline, negative 1M baseline
        XLB:  snSeries(() => 100),                                       // valid, unchanged => 0.00%
        XLU:  snSeries(i => 100 + i).map((r, i) => i === 299 ? null : r), // latest RECORD is null (not just its price)
        XLP:  snSeries(i => i === 299 ? -50 : 100),                      // negative endpoint, positive baseline
        XLRE: [{ x: '2018-01-01', y: 100 }, { x: '2018-01-02', y: 101 }, { x: '2018-01-03', y: 102 }], // short history
        XLC:  { bad: true }                                              // malformed (not a list)
    };
    const wtiGood = { labels: SN_DATES, prices: SN_DATES.map((_, i) => 50 + i) };
    const goldBad = { labels: SN_DATES, prices: SN_DATES.map((_, i) => i === 299 ? null : i === 294 ? '394' : 100 + i) };
    const app = await loadApp({ sectors, commodities: { Gold: goldBad, 'WTI Crude': wtiGood }, events: EVENTS_MAIN });
    app.flush();
    check('boot rendered without an exception', app.takeTimerErrors().length === 0);
    const html = app.byId('sector-flow-container')._html + app.byId('sector-flow-container').children.map(c => c._html).join('');
    const rows = sectorRowsOf(app);
    const na = 'N/A';
    check('header says trailing price returns (snapshot panel)', textOf(app.byId('sector-flow-container')).includes('TRAILING PRICE RETURNS'));
    check('no Infinity / NaN / undefined / -100.00% anywhere in the snapshot panel', !SNAP_BAD_TOKENS.test(html));

    eq('valid sector XLK: exact trailing returns (0.25 / 1.27 / 5.84 / 171.43)', rows['TECHNOLOGY (XLK)'].cells, ['0.25%', '1.27%', '5.84%', '171.43%']);
    eq('latest null: every horizon N/A (not -100.00%)', rows['ENERGY (XLE)'].cells, [na, na, na, na]);
    eq('1D baseline null: only 1D is N/A, the others are computed', rows['FINANCIALS (XLF)'].cells, [na, '1.27%', '5.84%', '171.43%']);
    eq('latest NaN: every horizon N/A', rows['HEALTHCARE (XLV)'].cells, [na, na, na, na]);
    eq('numeric-string / +Infinity / -Infinity baselines: each horizon N/A, 1D still valid', rows['CONS. DISC. (XLY)'].cells, ['0.25%', na, na, na]);
    eq('zero 1W baseline and negative 1M baseline are N/A; 1D and 1Y still valid', rows['INDUSTRIALS (XLI)'].cells, ['0.25%', na, na, '171.43%']);
    const xli = rows['INDUSTRIALS (XLI)'];
    check('zero / negative baseline reasons are in the tooltips', xli.titles.some(t => /baseline price is zero/.test(t)) && xli.titles.some(t => /baseline price is negative/.test(t)));
    eq('valid unchanged price: four real 0.00% returns, not N/A', rows['MATERIALS (XLB)'].cells, ['0.00%', '0.00%', '0.00%', '0.00%']);
    eq('null latest RECORD: N/A on every horizon and the panel still renders', rows['UTILITIES (XLU)'].cells, [na, na, na, na]);
    eq('negative endpoint with a positive baseline is a valid -150.00% change', rows['CONS. STAPLES (XLP)'].cells, ['-150.00%', '-150.00%', '-150.00%', '-150.00%']);
    eq('short history: 1D computed (0.99%), longer horizons N/A', rows['REAL ESTATE (XLRE)'].cells, ['0.99%', na, na, na]);
    eq('malformed (non-list) sector series: N/A row with a reason, no exception', rows['COMM. SVCS (XLC)'].cells, [na, na, na, na]);
    check('malformed sector row carries its reason', rows['COMM. SVCS (XLC)'].titles.every(t => /series malformed/.test(t)));
    check('valid rows render alongside the bad ones (11 sector rows present)', Object.keys(rows).filter(k => /\(XL/.test(k)).length === 11);

    eq('Gold (latest null, numeric-string baseline): all horizons N/A', rows['GOLD'].cells, [na, na, na, na]);
    eq('WTI Crude valid: exact trailing returns (0.29 / 1.45 / 6.73 / 259.79)', rows['WTI CRUDE'].cells, ['0.29%', '1.45%', '6.73%', '259.79%']);

    // Gold with only the 1W baseline stored as a string: other horizons still compute
    const g2 = { labels: SN_DATES, prices: SN_DATES.map((_, i) => i === 294 ? '394' : 100 + i) };
    const app2 = await loadApp({ sectors: { XLK: snSeries(i => 100 + i) }, commodities: { Gold: g2, 'WTI Crude': wtiGood }, events: EVENTS_MAIN });
    eq('numeric-string baseline is unavailable for that horizon only', sectorRowsOf(app2)['GOLD'].cells, ['0.25%', na, '5.84%', '171.43%']);

    // Negative finite commodity price at the endpoint with a positive baseline
    const wtiNeg = { labels: SN_DATES, prices: SN_DATES.map((_, i) => i === 299 ? -37.63 : 50 + i) };
    const app3 = await loadApp({ sectors: { XLK: snSeries(i => 100 + i) }, commodities: { Gold: wtiGood, 'WTI Crude': wtiNeg }, events: EVENTS_MAIN });
    const w = sectorRowsOf(app3)['WTI CRUDE'];
    eq('negative WTI endpoint (-37.63 vs 348): a real -110.81% 1D change, not N/A', w.cells[0], '-110.81%');
    check('negative-endpoint row has no malformed tokens', !/Infinity|NaN|undefined/.test(w.html));
    // zero Gold baseline at 1W
    const goldZero = { labels: SN_DATES, prices: SN_DATES.map((_, i) => i === 294 ? 0 : 100 + i) };
    const app4 = await loadApp({ sectors: { XLK: snSeries(i => 100 + i) }, commodities: { Gold: goldZero, 'WTI Crude': wtiGood }, events: EVENTS_MAIN });
    eq('zero commodity baseline: that horizon N/A, others computed', sectorRowsOf(app4)['GOLD'].cells, ['0.25%', na, '5.84%', '171.43%']);
});

section('16c. Latest Snapshot master chart: invalid values, unavailable series, displays', async () => {
    // (i) invalid records inside the window: gaps; baseline = first VALID price
    const app = await mbApp({
        Gold: mbSeries(p => { p[0] = null; p[1] = NaN; p[2] = '103'; p[3] = Infinity; p[4] = -Infinity; }),
        'WTI Crude': mbSeries(p => p.forEach((_, i) => { p[i] = 50 + i; }))
    });
    const gold = masterDs(app, 'Gold');
    const gy = ys(gold);
    eq('invalid records (null, NaN, numeric string, +/-Infinity) are gaps, not values', gy.slice(0, 5), [null, null, null, null, null]);
    eq('baseline is the first valid price (index 5 = 105): 0.000, then +0.952', [gy[5], gy[6]], [0, 0.952]);
    check('no plotted Gold value is NaN / infinite / below -100 from coercion', gy.every(v => v === null || (Number.isFinite(v) && v > -100)));
    eq('WTI unaffected by the invalid Gold records (first price 50 => 0, then 2.000)', ys(masterDs(app, 'WTI Crude')).slice(0, 2), [0, 2]);

    // (ii) zero baseline: unavailable, NOT skipped forward; other series intact
    const z = await mbApp({ Gold: mbSeries(), 'WTI Crude': mbSeries(p => { p[0] = 0; }) });
    const zw = masterDs(z, 'WTI Crude');
    check('zero baseline: legend says N/A with the reason', zw.label === 'WTI Crude (N/A: baseline price is zero)', 'snapshot');
    check('zero baseline: no percentage points (was a silent re-baseline to the next price)', ys(zw).every(v => v === null));
    eq('zero baseline in one series does not block Gold (0.000, then +1.000)', ys(masterDs(z, 'Gold')).slice(0, 2), [0, 1]);

    // (iii) negative baseline (also when it is the first VALID price after nulls)
    const ng = await mbApp({ Gold: mbSeries(), 'WTI Crude': mbSeries(p => { p[0] = null; p[1] = -5; }) });
    const nw = masterDs(ng, 'WTI Crude');
    check('negative first valid price: unavailable with the negative-baseline reason',
        /^WTI Crude \(N\/A: baseline price is negative/.test(nw.label) && ys(nw).every(v => v === null), 'snapshot');

    // (iv) valid unchanged price => 0, not N/A
    const u = await mbApp({ Gold: mbSeries(p => p.fill(100)), 'WTI Crude': mbSeries() });
    const uy = ys(masterDs(u, 'Gold'));
    check('unchanged price plots a real 0 at every date (not null, not -0)', uy.every(v => v === 0 && !Object.is(v, -0)));
    check('unchanged series keeps its plain legend (not marked N/A)', masterDs(u, 'Gold').label === 'Gold');

    // (v) negative endpoint + tooltip formatting
    const ne = await mbApp({ Gold: mbSeries(), 'WTI Crude': mbSeries(p => { p.forEach((_, i) => { p[i] = 50 + i; }); p[10] = -10; }) });
    const nep = ys(masterDs(ne, 'WTI Crude'))[10];
    eq('finite negative endpoint with positive baseline: -120.000% is plotted', nep, -120);
    const cb = ne.liveChart('master-canvas').config.options.plugins.tooltip.callbacks;
    const tip = cb.label({ dataset: { label: 'WTI Crude' }, parsed: { y: -120 }, label: MB_DATES[10] });
    check('tooltip shows the negative raw price as -$10.00 (not "$-10.00")', /-120\.00% price return/.test(tip) && tip.includes('(-$10.00)') && !tip.includes('$-'), 'snapshot');
    check('tooltip for a gap says no data (null and NaN)', cb.label({ dataset: { label: 'Gold' }, parsed: { y: null }, label: MB_DATES[0] }) === 'Gold: no data' &&
        cb.label({ dataset: { label: 'Gold' }, parsed: { y: NaN }, label: MB_DATES[0] }) === 'Gold: no data');

    // (vi) malformed series do not block valid ones
    const mal = await mbApp({ Gold: mbSeries(), Bad1: { labels: MB_DATES }, Bad2: { labels: MB_DATES, prices: [1, 2, 3] } });
    mal.setChecked(['Gold', 'Bad1', 'Bad2']);
    mal.run('updateMasterChart()');
    const mc = mal.liveChart('master-canvas');
    check('chart still drawn for the valid series', !!mc && ys(masterDs(mal, 'Gold')).slice(0, 2).join() === '0,1');
    check('prices-missing series is listed as N/A with its reason', mc.config.data.datasets.some(d => d.label === 'Bad1 (N/A: prices missing)'));
    check('length-mismatch series is listed as N/A with its reason', mc.config.data.datasets.some(d => d.label === 'Bad2 (N/A: labels (60) and prices (3) have different lengths)'));

    // (vii) every selected series unavailable => explicit message; recovery when a valid one is added
    const all = await mbApp({ Gold: mbSeries(p => { p[0] = 0; }), 'WTI Crude': mbSeries(p => { p[0] = -1; }), Silver: mbSeries() });
    const msg = all.byId('master-canvas-wrap').querySelector('.chart-no-data-msg');
    check('all selected series unavailable: explicit message with reasons, canvas hidden, no live chart',
        !!msg && /Percentage returns unavailable/.test(msg.textContent) && /Gold: baseline price is zero/.test(msg.textContent) &&
        /WTI Crude: baseline price is negative/.test(msg.textContent) && all.byId('master-canvas').style.display === 'none' && all.liveChart('master-canvas') === null, 'snapshot');
    all.setChecked(['Gold', 'Silver']);
    all.run('updateMasterChart()');
    check('selecting a valid series recovers the chart and removes the message',
        all.liveChart('master-canvas') !== null && all.byId('master-canvas').style.display === '' && all.byId('master-canvas-wrap').querySelector('.chart-no-data-msg') === null &&
        masterDs(all, 'Gold').label.startsWith('Gold (N/A:') && ys(masterDs(all, 'Silver')).slice(0, 2).join() === '0,1');
});

section('16d. Latest Snapshot barometer: invalid values and negative prices', async () => {
    const app = await mbApp({ Gold: mbSeries(p => { p[55] = null; p[56] = NaN; p[57] = '100'; p[58] = -5; p[59] = Infinity; }), 'WTI Crude': mbSeries() });
    app.run("selectBarometerCommodity('Gold')");
    const bc = app.liveChart('barometer-canvas');
    const d = bc.config.data.datasets[0].data;
    eq('barometer: null / NaN / numeric-string / Infinity become gaps; negative price is plotted', [d[55], d[56], d[57], d[58], d[59]], [null, null, null, -5, null]);
    check('barometer: valid prices untouched', d[0] === 100 && d[54] === 154);
    const cb = bc.config.options.plugins.tooltip.callbacks;
    eq('barometer tooltip: negative price is -$5.00', cb.label({ dataset: { label: 'Gold' }, parsed: { y: -5 } }), 'Gold: -$5.00');
    eq('barometer tooltip: positive price unchanged', cb.label({ dataset: { label: 'Gold' }, parsed: { y: 154 } }), 'Gold: $154.00');
    eq('barometer tooltip: gap does not throw', cb.label({ dataset: { label: 'Gold' }, parsed: { y: null } }), 'Gold: no data');

    const bad = await mbApp({ Gold: { labels: MB_DATES }, 'WTI Crude': mbSeries(), Bad2: { labels: MB_DATES, prices: [1] } });
    bad.run("selectBarometerCommodity('Gold')");
    const m1 = bad.byId('barometer-canvas-wrap').querySelector('.chart-no-data-msg');
    check('barometer: missing prices => explicit message, no exception', !!m1 && /unavailable/.test(m1.textContent) && bad.liveChart('barometer-canvas') === null);
    bad.run("selectBarometerCommodity('Bad2')");
    check('barometer: length-mismatch series => explicit message', /unavailable/.test(bad.byId('barometer-canvas-wrap').querySelector('.chart-no-data-msg').textContent));
    bad.run("selectBarometerCommodity('WTI Crude')");
    check('barometer recovers on a valid series', bad.liveChart('barometer-canvas') !== null && bad.byId('barometer-canvas-wrap').querySelector('.chart-no-data-msg') === null);
});

section('16e. Ordinary rolling controls still show the corresponding data', async () => {
    const app = await mainApp(); // 1300 weekdays 2015-01-01 .. 2019-12-25, now = 2019-12-25
    // CHANGED (snapshot date-and-gap checkpoint). Old expectation: the first included label was the cutoff date OR
    // the following weekday, because the old cutoff mixed local-midnight arithmetic with UTC-midnight labels and so
    // depended on the machine time zone. New expectation: ONE exact date under the documented convention (windows
    // are anchored to today's UTC date; the cutoff date itself is included), identical in every time zone.
    // Authorizing requirement: "Remove any test allowance accepting two different boundary dates solely because of timezone."
    const FIRST = { '1W': '2019-12-18', '1M': '2019-11-25', '3M': '2019-09-25', '6M': '2019-06-25', 'YTD': '2019-01-01', '1Y': '2018-12-25' };
    Object.entries(FIRST).forEach(([tf, cutoff]) => {
        app.click(`master-tf-${tf}`);
        const mc = app.liveChart('master-canvas');
        const labels = mc.config.data.labels;
        const gold = mc.config.data.datasets.find(x => x.label === 'Gold');
        const first = labels[0];
        eq(`master ${tf}: window starts exactly at the cutoff date and ends at the latest date`, [first, labels[labels.length - 1]], [cutoff, '2019-12-25']);
        check(`master ${tf}: the fixture date before the window start is before the cutoff (earlier data is excluded)`, LIN_GOLD.labels[LIN_GOLD.labels.indexOf(first) - 1] < cutoff);
        const p0 = LIN_GOLD.prices[LIN_GOLD.labels.indexOf(first)], p1 = LIN_GOLD.prices[LIN_N - 1]; // fixture prices at the cutoff / latest
        check(`master ${tf}: Gold starts at 0 and ends at the real window return`, gold.data[0].y === 0 && gold.data.every(p => Number.isFinite(p.y)) &&
            Math.abs(gold.data[gold.data.length - 1].y - (p1 - p0) / p0 * 100) < 0.0006);
        eq(`master ${tf}: one active button and snapshot timeframe state`, [app.activeIds('master-tf-btn'), app.run('activeMasterTimeframe')], [[`master-tf-${tf}`], tf]);
    });
    app.click('master-tf-1W');
    eq('1W window holds exactly 6 observations (12-18, 19, 20, 23, 24, 25)', app.liveChart('master-canvas').config.data.labels.length, 6);
    app.run("selectBarometerCommodity('Gold')");
    app.click('baro-tf-3M');
    const bc = app.liveChart('barometer-canvas');
    eq('barometer 3M: first/last label are exactly the cutoff 2019-09-25 and the latest date', [bc.config.data.labels[0], bc.config.data.labels[bc.config.data.labels.length - 1]], ['2019-09-25', '2019-12-25']);
    eq('barometer 3M: last price is the fixture value; data length equals label length', [bc.config.data.datasets[0].data.pop(), bc.config.data.datasets[0].data.length + 1 === bc.config.data.labels.length], [LIN_GOLD.prices[LIN_N - 1], true]);
    eq('barometer 3M: one active barometer button', app.activeIds('baro-tf-btn'), ['baro-tf-3M']);
    check('snapshot YTD buttons keep the plain "YTD" label', ['baro-tf-YTD', 'master-tf-YTD'].every(id => app.byId(id).textContent === 'YTD'));
});

section('16f. Event -> Latest Snapshot: no stale event panels, bad data stays unavailable, rapid switching', async () => {
    const sectors = {
        XLK: snSeries(i => 100 + i),
        XLE: snSeries(i => i === 299 ? null : 100 + i),
        XLI: snSeries(i => i === 294 ? 0 : 100 + i),
        XLB: snSeries(() => 100)
    };
    const app = await loadApp({ sectors, events: EVENTS_MAIN });
    const snapshotRows = () => JSON.stringify(Object.entries(sectorRowsOf(app)).map(([k, v]) => [k, v.cells]));
    const before = snapshotRows();
    const initialLabels = app.liveChart('master-canvas').config.data.labels.slice();
    eq('boot snapshot: unavailable rows are N/A, valid unchanged row is 0.00%',
        [sectorRowsOf(app)['ENERGY (XLE)'].cells[0], sectorRowsOf(app)['MATERIALS (XLB)'].cells[0]], ['N/A', '0.00%']);

    const assertSnapshot = (tag) => {
        const s = app.state();
        const sector = textOf(app.byId('sector-flow-container'));
        check(`${tag}: event state cleared`, s.active === false && s.archiveDate === null && app.run('activeEventMode') === false);
        check(`${tag}: sector panel is the snapshot view, identical to the boot snapshot`, sector.includes('TRAILING PRICE RETURNS') && !sector.includes('RETROSPECTIVE') && snapshotRows() === before);
        check(`${tag}: impact panel is the snapshot placeholder, no event table`, app.panelHtml().includes('LATEST SNAPSHOT ACTIVE') && !app.panelHtml().includes('Archive:') && !app.panelHtml().includes('<table'));
        const sub = app.byId('master-chart-subtitle');
        check(`${tag}: event subtitle hidden`, sub && sub.textContent === '' && sub.style.display === 'none');
        const mc = app.liveChart('master-canvas');
        check(`${tag}: master chart is the rolling snapshot chart (same labels as boot, no event tags)`,
            !!mc && JSON.stringify(mc.config.data.labels) === JSON.stringify(initialLabels) && mc.config.data.datasets.every(d => !/Incomplete|Year-end|Excluded/.test(d.label)));
        eq(`${tag}: timeframe buttons back to snapshot state`, [app.activeIds('baro-tf-btn'), app.activeIds('master-tf-btn')], [['baro-tf-1Y'], ['master-tf-5Y']]);
        check(`${tag}: YTD labels restored`, ['baro-tf-YTD', 'master-tf-YTD'].every(id => app.byId(id).textContent === 'YTD'));
        check(`${tag}: no pending deferred work`, app.pendingTimers() === 0);
        check(`${tag}: no bad tokens in the sector panel`, !SNAP_BAD_TOKENS.test(app.byId('sector-flow-container').children.map(c => c._html).join('')));
    };

    app.run("selectBarometerCommodity('Gold')");
    app.click(app.all('.event-btn')[0]);
    app.flush();
    check('event mode really replaced the panels (precondition)', textOf(app.byId('sector-flow-container')).includes('RETROSPECTIVE') && app.panelHtml().includes('Archive:'));
    app.click('master-tf-3M'); // event horizon change while in event mode
    app.flush();
    app.click('today-btn');
    app.flush();
    assertSnapshot('event -> snapshot');
    check('barometer title has no event suffix after returning', !/EVENT/.test(app.byId('barometer-chart-title').textContent));

    // rolling controls work again after the round trip
    app.click('master-tf-1M');
    eq('after returning, master 1M is the rolling window again (exact cutoff 2019-11-25)', [app.liveChart('master-canvas').config.data.labels[0], app.state().active], ['2019-11-25', false]);
    app.click('master-tf-5Y');

    // rapid switching: A, B, C, snapshot (timers not flushed in between)
    app.click(app.all('.event-btn')[0]);
    app.click(app.all('.event-btn')[1]);
    app.click(app.all('.event-btn')[2]);
    app.click('today-btn');
    app.flush();
    assertSnapshot('rapid A,B,C -> snapshot');

    // snapshot -> event -> snapshot -> event -> snapshot with the deferred work interleaved
    app.click(app.all('.event-btn')[1]);
    app.click('today-btn');
    app.click(app.all('.event-btn')[2]);
    app.flush();
    check('last action wins: event C is shown', app.state().active === true && app.state().archiveDate === '2015-06-01' && app.panelHtml().includes('Archive: <code>2015-06-01</code>'));
    app.click('today-btn');
    app.click('today-btn'); // repeated snapshot click is harmless
    app.flush();
    assertSnapshot('interleaved, repeated snapshot clicks');

    // dropdown route
    app.change('fx-event-select', '0');
    app.flush();
    app.change('fx-event-select', 'snapshot');
    app.flush();
    assertSnapshot('dropdown event -> snapshot');
    check('no uncaught exception in any deferred callback', app.takeTimerErrors().length === 0);
});

// ============================================================
// SNAPSHOT DATE-AND-GAP INTEGRITY COVERAGE (sections 17a-17j)
// Production functions and real handlers only. Conventions under test (PROJECT_CONTEXT.md):
//  * snapshot series are validated (paired, sorted, duplicate/invalid dates, unequal lengths) before slicing;
//  * each instrument is aligned by its OWN actual dates; absent dates are never filled;
//  * baseline = first finite price in the window, strictly positive; dates are disclosed per instrument;
//  * explicit invalid points break the line; >7-calendar-day gaps are screened (not a session audit);
//  * rolling windows are anchored to today's UTC date; the cutoff date is included.
// ============================================================

const ctxText = (app, id) => { const el = app.byId(id); return el ? el.textContent : null; };
const ptAt = (ds, date) => ds.data.find(p => p.x === date);
const plainJ = (x) => JSON.parse(JSON.stringify(x));

section('17a. sliceByTimeframe validates before slicing (no mutation, explicit reasons)', async () => {
    const app = await mainApp();
    const slice = app.fn('sliceByTimeframe');
    const ref = new Date('2020-06-01T12:00:00Z');

    const labels = ['2020-01-03', '2020-01-01', '2020-01-02', '2020-01-06'];
    const prices = [3, 1, 'x', 6];
    const l0 = labels.slice(), p0 = prices.slice();
    const r = slice(labels, prices, 'MAX', null, ref);
    eq('unsorted pairs are sorted together: dates and prices stay paired', [plainJ(r.labels), plainJ(r.prices)],
        [['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-06'], [1, null, 3, 6]]);
    eq('the invalid price keeps its own date as a gap (not dropped, not 0)', r.prices[1], null);
    eq('day numbers are consecutive calendar days in the sorted order', plainJ(r.days.slice(1).map((d, i) => d - r.days[i])), [1, 1, 3]);
    eq('source arrays are not mutated', [labels, prices], [l0, p0]);
    check('valid series: not flagged invalid, not empty', r.noData === false && r.seriesInvalid === false);

    const bad = [
        ['duplicate dates', ['2020-01-01', '2020-01-01'], [1, 2], /duplicate date 2020-01-01/],
        ['impossible calendar date', ['2020-01-01', '2020-02-30'], [1, 2], /invalid calendar date at position 1: 2020-02-30/],
        ['non-ISO date', ['01/02/2020', '2020-01-03'], [1, 2], /invalid calendar date at position 0: 01\/02\/2020/],
        ['unequal lengths', ['2020-01-01', '2020-01-02', '2020-01-03'], [1, 2], /labels \(3\) and prices \(2\) have different lengths/],
        ['prices missing', ['2020-01-01'], undefined, /labels or prices missing/]
    ];
    bad.forEach(([what, l, p, re]) => {
        const x = slice(l, p, 'MAX', null, ref);
        check(`${what}: series unavailable with a series-specific reason, nothing fabricated`,
            x.noData === true && x.seriesInvalid === true && re.test(x.reason) && x.labels.length === 0 && x.prices.length === 0);
    });

    const w = slice(['2020-01-01'], [1], '1W', null, ref);
    check('empty window: explicit noData (not invalid), never widened to full history, cutoff disclosed',
        w.noData === true && w.seriesInvalid === false && w.labels.length === 0 && w.cutoffDate === '2020-05-25' && w.latestAvailableDate === '2020-01-01');
    const e = slice([], [], '1M', null, ref);
    check('no observations at all: noData, not invalid', e.noData === true && e.seriesInvalid === false);
});

section('17b. Master chart: unsorted source pairs and bad series do not block valid instruments', async () => {
    const gold = mbSeries();
    const goldRev = { labels: gold.labels.slice().reverse(), prices: gold.prices.slice().reverse() }; // unsorted source pairs
    const goldRevJson = JSON.stringify(goldRev);
    const app = await mbApp({
        Gold: goldRev,
        'WTI Crude': mbSeries(p => p.forEach((_, i) => { p[i] = 50 + i; })),
        DupSeries: { labels: [MB_DATES[0], MB_DATES[1], MB_DATES[1]], prices: [1, 2, 3] },
        BadDate: { labels: [MB_DATES[0], '2015-02-30'], prices: [1, 2] },
        Short: { labels: MB_DATES, prices: [1, 2] }
    });
    app.setChecked(['Gold', 'WTI Crude', 'DupSeries', 'BadDate', 'Short']);
    app.run('updateMasterChart()');
    const mc = app.liveChart('master-canvas');
    const g = masterDs(app, 'Gold');
    eq('Gold (reverse-ordered source) is plotted in chronological order', g.data.map(p => p.x), MB_DATES);
    eq('Gold keeps date/price pairing: 0.000 on the first date, +1.000 next, +59.000 on the last',
        [ptAt(g, MB_DATES[0]).y, ptAt(g, MB_DATES[1]).y, ptAt(g, MB_DATES[59]).y], [0, 1, 59]);
    const sortedApp = await mbApp({ Gold: gold, 'WTI Crude': mbSeries(p => p.forEach((_, i) => { p[i] = 50 + i; })) });
    eq('result equals the chart built from already-sorted input', plainJ(g.data), plainJ(masterDs(sortedApp, 'Gold').data));
    eq('the loaded source data was not mutated by the chart code', app.run("JSON.stringify(commodityData['Gold'])"), goldRevJson);
    eq('WTI still plotted next to three rejected series', ptAt(masterDs(app, 'WTI Crude'), MB_DATES[1]).y, 2);
    const names = mc.config.data.datasets.map(d => d.label);
    check('duplicate-date series: legend says N/A with the duplicate date', names.some(n => /^DupSeries \(N\/A: duplicate date 2015-01-02/.test(n)));
    check('impossible-date series: legend says N/A with the position and value', names.some(n => /^BadDate \(N\/A: invalid calendar date at position 1: 2015-02-30/.test(n)));
    check('unequal-length series: legend says N/A with both lengths', names.some(n => /^Short \(N\/A: labels \(60\) and prices \(2\) have different lengths/.test(n)));
    const ctx = ctxText(app, 'master-snapshot-context');
    check('rejected series are listed under "Unavailable" in the chart context with their reasons',
        /Unavailable: .*DupSeries \(duplicate date/.test(ctx) && /BadDate \(invalid calendar date/.test(ctx) && /Short \(labels \(60\)/.test(ctx));
});

section('17c. Different instrument calendars: actual-date alignment, per-series baselines, tooltips', async () => {
    const SIL = { labels: MB_DATES.filter((_, i) => i >= 10 && i % 2 === 0), prices: MB_DATES.map((_, i) => 200 + i).filter((_, i) => i >= 10 && i % 2 === 0) };
    const COP = { labels: ['2015-01-03', '2015-01-05', '2015-01-06'], prices: [10, 11, 12] }; // 01-03 is a Saturday absent from Gold
    const app = await mbApp({ Gold: mbSeries(), Silver: SIL, Copper: COP });
    app.setChecked(['Gold', 'Silver', 'Copper']);
    app.run('updateMasterChart()');
    const mc = app.liveChart('master-canvas');
    const gold = masterDs(app, 'Gold'), sil = masterDs(app, 'Silver'), cop = masterDs(app, 'Copper');
    eq('x axis = sorted union of the instruments\' actual dates', mc.config.data.labels, Array.from(new Set(MB_DATES.concat(COP.labels))).sort());
    eq('Silver has points ONLY on its own dates (no fill on Gold\'s dates)', sil.data.map(p => p.x), SIL.labels);
    eq('Silver is normalised to its own first date: 0.000 then +0.952', [sil.data[0].y, sil.data[1].y], [0, 0.952]);
    check('Gold has no point on Copper\'s extra Saturday', !gold.data.some(p => p.x === '2015-01-03'));
    eq('Copper own baseline (2015-01-03 @ 10): next observation is +10.000', [cop.data[0].y, cop.data[1].y], [0, 10]);
    const goldOnly = await mbApp({ Gold: mbSeries() });
    eq('other instruments\' extra dates do not change Gold\'s returns (identical to Gold-only chart)', plainJ(gold.data), plainJ(masterDs(goldOnly, 'Gold').data));
    check('no synthetic values: every plotted y is a hand-checkable null or finite number', mc.config.data.datasets.every(d => d.data.every(p => p.y === null || Number.isFinite(p.y))));

    const cb = mc.config.options.plugins.tooltip.callbacks;
    const t1 = cb.label({ dataset: sil, parsed: { y: sil.data[1].y }, label: SIL.labels[1] });
    check('tooltip uses the instrument\'s own price on that date (Silver 212.00, not Gold\'s 112.00)', /Silver: \+0\.95% price return {2}\(\$212\.00\)/.test(t1), 'snapshot');
    const t2 = cb.label({ dataset: sil, parsed: { y: null }, label: MB_DATES[11] });
    check('tooltip for a date Silver does not have says no observation (not a value, not 0)', t2 === 'Silver: no data (no observation on 2015-01-16)', 'snapshot');
    const ti = cb.title([{ label: SIL.labels[0] }]);
    check('tooltip title marks the normalisation baseline of Silver on its baseline date', ti.includes('normalisation baseline') && ti.includes('Silver'));

    const ctx = ctxText(app, 'master-snapshot-context');
    check('different baselines are stated explicitly as different starting dates (no common investment period)',
        ctx.includes('DIFFERENT starting dates (not a common investment period)'));
    check('per-series baseline → last valid price dates are listed',
        ctx.includes(`Gold ${MB_DATES[0]} → ${MB_DATES[59]}`) && ctx.includes(`Silver ${SIL.labels[0]} → ${SIL.labels[SIL.labels.length - 1]}`) && ctx.includes('Copper 2015-01-03 → 2015-01-06'));

    const same = await mbApp({ Gold: mbSeries(), 'WTI Crude': mbSeries() });
    const c2 = ctxText(same, 'master-snapshot-context');
    check('identical baselines: no "different starting dates" claim, dates still listed',
        !c2.includes('DIFFERENT') && c2.includes(`Gold ${MB_DATES[0]} → ${MB_DATES[59]}`) && c2.includes(`WTI Crude ${MB_DATES[0]} → ${MB_DATES[59]}`));
    check('context states the window and UTC reference date', c2.includes('Window 5Y from 2010-04-01 (today, UTC: 2015-04-01)'));
});

section('17d. Zero / negative baselines stay unavailable and are disclosed (not searched past)', async () => {
    const z = await mbApp({ Gold: mbSeries(), 'WTI Crude': mbSeries(p => { p[0] = 0; }) });
    const w = masterDs(z, 'WTI Crude (N/A');
    check('zero first price: series unavailable, no points (not re-baselined to the next price)', !!w && w.label === 'WTI Crude (N/A: baseline price is zero)' && w.data.every(p => p.y === null));
    const c = ctxText(z, 'master-snapshot-context');
    check('reason and the actual first finite price/date are disclosed', c.includes('Unavailable: WTI Crude (baseline price is zero; first finite price 0 on 2015-01-01)'));
    const n = await mbApp({ Gold: mbSeries(), 'WTI Crude': mbSeries(p => { p[0] = null; p[1] = -5; }) });
    check('null then negative first valid price: unavailable; disclosure names -5 on 2015-01-02',
        ctxText(n, 'master-snapshot-context').includes('WTI Crude (baseline price is negative (percentage return needs a positive baseline); first finite price -5 on 2015-01-02)') &&
        masterDs(n, 'WTI Crude (N/A').data.every(p => p.y === null));
    eq('Gold baseline/ending dates still disclosed alongside the unavailable series', ctxText(n, 'master-snapshot-context').includes(`Gold ${MB_DATES[0]} → ${MB_DATES[59]}`), true);
    const pos = await mbApp({ Gold: mbSeries(), 'WTI Crude': mbSeries(p => { p.forEach((_, i) => { p[i] = 50 + i; }); p[10] = -10; }) });
    eq('positive baseline with a negative endpoint is still a valid change (-120.000)', ptAt(masterDs(pos, 'WTI Crude'), MB_DATES[10]).y, -120);
});

section('17e. Gaps: invalid points break the line; calendar-gap screen (> 7 days) is reported', async () => {
    const app = await mbApp({ Gold: mbSeries(p => { p[19] = null; p[21] = NaN; }), 'WTI Crude': mbSeries() });
    const g = masterDs(app, 'Gold');
    check('spanGaps is false (line breaks at explicit invalid points)', g.spanGaps === false);
    eq('invalid price points keep their dates and are null (never 0)', [ptAt(g, MB_DATES[19]).y, ptAt(g, MB_DATES[21]).y], [null, null]);
    eq('the isolated valid observation between two gaps is kept: +20.000 at index 20', ptAt(g, MB_DATES[20]).y, 20);
    eq('isolated valid point gets a visible marker (radius 2); neighbours on a line have none', [g.pointRadius[20], g.pointRadius[30]], [2, 0]);
    check('gap points are not plotted as zero or fabricated returns', g.data.filter(p => p.y === 0).length === 1 && g.data[0].y === 0);
    check('invalid price count disclosed', ctxText(app, 'master-snapshot-context').includes('Invalid price points shown as gaps: Gold 2'));
    check('no calendar gap over 7 days in this series => no gap warning', !ctxText(app, 'master-snapshot-context').includes('Calendar-gap screen'));

    const GAP = { labels: ['2015-01-05', '2015-01-06', '2015-01-07', '2015-01-14', '2015-01-22', '2015-02-20', '2015-02-23'], prices: [101, 102, 103, 104, 105, 106, 107] };
    const ga = await mbApp({ Gap: GAP });
    ga.setChecked(['Gap']);
    ga.run('updateMasterChart()');
    const c = ctxText(ga, 'master-snapshot-context');
    check('gap warning: largest gap 29 days (2015-01-22 → 2015-02-20) and the number of gaps over 7 days (8 and 29 days: 2)',
        c.includes('Gap largest 29 days (2015-01-22 → 2015-02-20), 2 gaps'));
    check('warning is labelled a calendar-gap screening rule, not an exchange-session audit', c.includes('Calendar-gap screen (more than 7 calendar days') && c.includes('not an exchange-session audit'));
    eq('no dates or prices were inserted: chart points are exactly the source observations', masterDs(ga, 'Gap').data.map(p => [p.x, p.y]).length, GAP.labels.length);
    eq('x axis holds only the source dates (no weekday filling)', ga.liveChart('master-canvas').config.data.labels, GAP.labels);
    const seven = await mbApp({ Seven: { labels: ['2015-01-05', '2015-01-12', '2015-01-13'], prices: [1, 2, 3] } });
    seven.setChecked(['Seven']);
    seven.run('updateMasterChart()');
    check('exactly 7 calendar days is not flagged (rule is "more than 7")', !ctxText(seven, 'master-snapshot-context').includes('Calendar-gap screen'));

    // barometer (raw price chart)
    ga.run("selectBarometerCommodity('Gap')");
    const bc = ga.liveChart('barometer-canvas');
    const bctx = ctxText(ga, 'barometer-snapshot-context');
    check('barometer: gap warning with largest gap, rule label and last valid price date', bctx.includes('largest 29 days (2015-01-22 → 2015-02-20), 2 gaps') && bctx.includes('not an exchange-session audit') && bctx.includes('last valid price 2015-02-23'));
    eq('barometer: only source dates are plotted', bc.config.data.labels, GAP.labels);
    const ba = await mbApp({ Gold: mbSeries(p => { p[19] = null; p[21] = NaN; }), 'WTI Crude': mbSeries() });
    ba.run("selectBarometerCommodity('Gold')");
    const bd = ba.liveChart('barometer-canvas').config.data.datasets[0];
    check('barometer snapshot: spanGaps false, invalid points null, isolated valid point visible',
        bd.spanGaps === false && bd.data[19] === null && bd.data[21] === null && bd.data[20] === 120 && bd.pointRadius[20] === 2);
    check('barometer: invalid point count disclosed', ctxText(ba, 'barometer-snapshot-context').includes('2 invalid price point(s) shown as gaps'));
    // event mode keeps its own (unchanged) barometer line behaviour
    ba.click(ba.all('.event-btn')[0]);
    ba.flush();
    eq('event mode barometer keeps spanGaps true (event chart behaviour unchanged)', ba.liveChart('barometer-canvas').config.data.datasets[0].spanGaps, true);
});

section('17f. Rolling-window boundaries: UTC calendar arithmetic, month-end clamping, leap years', async () => {
    const app = await mainApp();
    const cut = (tf, iso) => app.fn('dayToIso')(app.fn('snapshotCutoffDay')(tf, new Date(iso)));
    [
        ['1M', '2019-03-31T12:00:00Z', '2019-02-28'],   // clamp to the last day of a short month
        ['1M', '2020-03-31T12:00:00Z', '2020-02-29'],   // leap year
        ['1M', '2019-03-29T12:00:00Z', '2019-02-28'],   // Feb 29 does not exist in 2019
        ['1M', '2020-03-29T12:00:00Z', '2020-02-29'],
        ['1M', '2021-01-31T12:00:00Z', '2020-12-31'],
        ['1M', '2019-01-15T12:00:00Z', '2018-12-15'],   // year rollover
        ['1M', '2019-03-01T12:00:00Z', '2019-02-01'],
        ['3M', '2019-05-31T12:00:00Z', '2019-02-28'],
        ['6M', '2019-08-31T12:00:00Z', '2019-02-28'],
        ['6M', '2020-08-31T12:00:00Z', '2020-02-29'],
        ['1Y', '2020-02-29T12:00:00Z', '2019-02-28'],   // leap day minus one year
        ['1Y', '2019-12-25T12:00:00Z', '2018-12-25'],
        ['5Y', '2020-02-29T12:00:00Z', '2015-02-28'],
        ['5Y', '2019-12-25T12:00:00Z', '2014-12-25'],
        ['1W', '2019-03-03T12:00:00Z', '2019-02-24'],
        ['1W', '2020-03-03T12:00:00Z', '2020-02-25'],   // crosses Feb 29
        ['YTD', '2019-06-15T12:00:00Z', '2019-01-01'],
        ['YTD', '2020-01-01T00:30:00Z', '2020-01-01'],
        ['MAX', '2019-06-15T12:00:00Z', '2005-01-01'],  // fixed floor, not "all history"
        ['XYZ', '2019-12-25T12:00:00Z', '2014-12-25'],  // unknown timeframe falls back to 5Y
        ['1W', '2019-12-25T23:59:59Z', '2019-12-18'],   // same UTC date -> same cutoff at any clock time
        ['1W', '2019-12-26T00:00:00Z', '2019-12-19']
    ].forEach(([tf, iso, expected]) => eq(`${tf} at ${iso} -> ${expected}`, cut(tf, iso), expected));

    const slice = app.fn('sliceByTimeframe');
    const r = slice(['2019-11-24', '2019-11-25', '2019-11-26'], [1, 2, 3], '1M', null, new Date('2019-12-25T12:00:00Z'));
    eq('the cutoff date itself is included; the day before is excluded', plainJ(r.labels), ['2019-11-25', '2019-11-26']);
    const feb = slice(['2019-02-27', '2019-02-28', '2019-03-01'], [1, 2, 3], '1M', null, new Date('2019-03-31T23:00:00Z'));
    eq('month-end clamped window starts on 2019-02-28', plainJ(feb.labels), ['2019-02-28', '2019-03-01']);

    // both charts in one render use one reference clock; windows are today-based, not latest-observation based
    const old = { labels: weekdays('2025-12-01', 25), prices: weekdays('2025-12-01', 25).map((_, i) => 100 + i) };
    const fresh = { labels: weekdays('2026-03-02', 10), prices: weekdays('2026-03-02', 10).map((_, i) => 50 + i) };
    const both = await loadApp({ commodities: { Gold: old, 'WTI Crude': fresh }, events: [], now: '2026-03-15T12:00:00Z' });
    both.click('master-tf-1M');
    const mc = both.liveChart('master-canvas');
    const goldDs = mc.config.data.datasets.find(d => d.label.startsWith('Gold'));
    check('stale Gold has no points in the 1M window (window is anchored to today, not to Gold\'s last observation) while WTI does',
        /^Gold \(no data in period\)$/.test(goldDs.label) && mc.config.data.datasets.find(d => d.label === 'WTI Crude').data.length === 10);
    eq('1M window starts on the exact UTC cutoff 2026-02-15; every plotted date is on/after it', [mc.config.data.labels.every(d => d >= '2026-02-15'), mc.config.data.labels[0]], [true, '2026-03-02']);
});

section('17g. Identical boundaries under UTC, America/Toronto, Pacific/Auckland (UTC+12/13), Asia/Kolkata', async () => {
    const cp = require('child_process');
    const probe = `
        const fs = require('fs'), vm = require('vm');
        const code = fs.readFileSync(process.env.KUTUN_APP_JS, 'utf8');
        const noop = () => {};
        const sb = { document: { addEventListener: noop, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, createElement: () => ({}) },
            window: { addEventListener: noop }, console: { log: noop, warn: noop, error: noop }, Chart: function () {},
            fetch: async () => ({ ok: false }), setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0 };
        vm.createContext(sb); vm.runInContext(code, sb);
        const labels = [], prices = [];
        for (let d = new Date('2014-01-01T00:00:00Z'); d < new Date('2021-01-01T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
            if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) { labels.push(d.toISOString().slice(0, 10)); prices.push(100 + labels.length); }
        }
        const refs = ['2019-12-25T12:00:00Z', '2019-12-25T23:30:00Z', '2019-12-26T00:30:00Z', '2020-03-31T02:00:00Z', '2020-02-29T23:59:00Z', '2019-03-31T18:00:00Z'];
        const tfs = ['1W', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'MAX'];
        const out = { offsetJan: new Date('2019-01-15T12:00:00Z').getTimezoneOffset(), cut: {}, win: {} };
        refs.forEach(ref => tfs.forEach(tf => {
            const ref_ = new Date(ref);
            out.cut[ref + '|' + tf] = sb.dayToIso(sb.snapshotCutoffDay(tf, ref_));
            const r = sb.sliceByTimeframe(labels, prices, tf, null, ref_);
            out.win[ref + '|' + tf] = r.labels[0] + '>' + r.labels[r.labels.length - 1] + '#' + r.labels.length;
        }));
        console.log(JSON.stringify(out));`;
    const zones = [['UTC', 0], ['America/Toronto', 300], ['Pacific/Auckland', -780], ['Asia/Kolkata', -330]];
    const results = {};
    zones.forEach(([tz, offset]) => {
        const res = cp.spawnSync(process.execPath, ['-e', probe], { env: Object.assign({}, process.env, { TZ: tz, KUTUN_APP_JS: APP_JS_PATH }), encoding: 'utf8' });
        let parsed = null;
        try { parsed = JSON.parse(res.stdout); } catch (e) { /* reported below */ }
        check(`${tz}: probe ran (exit ${res.status}) and produced output`, res.status === 0 && !!parsed);
        if (!parsed) { console.error(res.stderr); return; }
        check(`${tz}: the time zone really applied (January offset ${offset} minutes)`, parsed.offsetJan === offset);
        results[tz] = parsed;
    });
    const base = results.UTC;
    if (base) {
        zones.slice(1).forEach(([tz]) => {
            if (!results[tz]) return;
            eq(`${tz}: every cutoff date equals the UTC result`, results[tz].cut, base.cut);
            eq(`${tz}: every window (first>last#count) equals the UTC result`, results[tz].win, base.win);
        });
        eq('exact boundary: 1W at 2019-12-25T23:30Z -> 2019-12-18 (Toronto and Auckland local dates differ from UTC)', base.cut['2019-12-25T23:30:00Z|1W'], '2019-12-18');
        eq('exact boundary: 1W at 2019-12-26T00:30Z -> 2019-12-19', base.cut['2019-12-26T00:30:00Z|1W'], '2019-12-19');
        eq('exact boundary: 1M at 2019-12-25T12:00Z window', base.win['2019-12-25T12:00:00Z|1M'].split('>')[0], '2019-11-25');
        eq('exact boundary: 1Y at 2020-02-29 -> 2019-02-28 (leap day)', base.cut['2020-02-29T23:59:00Z|1Y'], '2019-02-28');
        eq('exact boundary: 1M at 2020-03-31T02:00Z -> 2020-02-29', base.cut['2020-03-31T02:00:00Z|1M'], '2020-02-29');
    }
});

section('17h. Empty window: explicit state, then normal recovery', async () => {
    const msgOf = (app, wrapId) => app.byId(wrapId).querySelector('.chart-no-data-msg');
    const old = { labels: weekdays('2025-12-01', 25), prices: weekdays('2025-12-01', 25).map((_, i) => 100 + i) };
    const app = await loadApp({ commodities: { Gold: old, 'WTI Crude': old }, events: [], now: '2026-03-15T12:00:00Z' });
    app.run("selectBarometerCommodity('Gold')");
    check('precondition: 5Y window populated and its chart context is shown', app.liveChart('master-canvas') !== null && ctxText(app, 'master-snapshot-context').includes('Window 5Y from 2021-03-15'));
    app.click('master-tf-1W');
    const m = msgOf(app, 'master-canvas-wrap').textContent;
    check('1W: explicit empty-window message with latest available date and the window start', m.includes('No data in this period') && m.includes('Latest available: 2026-01-02') && m.includes('1W window starts 2026-03-08'));
    check('1W: no chart is drawn (full history is NOT shown) and the chart context is cleared', app.liveChart('master-canvas') === null && app.byId('master-canvas').style.display === 'none' && ctxText(app, 'master-snapshot-context') === '');
    app.click('baro-tf-1M');
    check('barometer 1M: explicit empty-window message, context cleared', /No data in this period — latest available: 2026-01-02/.test(msgOf(app, 'barometer-canvas-wrap').textContent) && app.liveChart('barometer-canvas') === null && ctxText(app, 'barometer-snapshot-context') === '');
    app.click('master-tf-3M');
    const mc = app.liveChart('master-canvas');
    eq('3M recovers: first plotted date is exactly the cutoff 2025-12-15 (earlier Dec data excluded)', [mc.config.data.labels[0], mc.config.data.labels.every(d => d >= '2025-12-15')], ['2025-12-15', true]);
    check('3M recovers: message removed, canvas visible, context back', msgOf(app, 'master-canvas-wrap') === null && app.byId('master-canvas').style.display === '' && ctxText(app, 'master-snapshot-context').includes('Window 3M from 2025-12-15'));
    app.click('baro-tf-1Y');
    check('barometer recovers on a populated window', app.liveChart('barometer-canvas') !== null && msgOf(app, 'barometer-canvas-wrap') === null && ctxText(app, 'barometer-snapshot-context').includes('Window 1Y from 2025-03-15'));
    app.click('master-tf-1W');
    app.click('master-tf-5Y');
    check('empty -> populated again (5Y) restores the chart', app.liveChart('master-canvas') !== null && msgOf(app, 'master-canvas-wrap') === null);
});

section('17i. Sector and commodity trailing returns use validated, date-sorted series', async () => {
    const sorted = snSeries(i => 100 + i);
    const sectors = {
        XLK: sorted,
        XLE: sorted.slice().reverse(),                                        // same records, reverse order
        XLF: sorted.slice(0, 299).concat([{ x: sorted[10].x, y: 5 }]),        // duplicate date (ambiguous)
        XLV: sorted.map((r, i) => i === 40 ? { x: '2018-02-30', y: r.y } : r), // impossible calendar date
        XLY: sorted.map((r, i) => i === 299 ? null : r)                       // null record (no date)
    };
    const wti = { labels: SN_DATES, prices: SN_DATES.map((_, i) => 50 + i) };
    const goldDup = { labels: SN_DATES.map((d, i) => i === 299 ? SN_DATES[0] : d), prices: SN_DATES.map((_, i) => 100 + i) };
    const app = await loadApp({ sectors, commodities: { Gold: goldDup, 'WTI Crude': wti }, events: EVENTS_MAIN });
    const rows = sectorRowsOf(app);
    const rowEl = (label) => app.byId('sector-flow-container').children.find(c => c._html.includes(label));
    eq('valid sorted sector: exact trailing returns', rows['TECHNOLOGY (XLK)'].cells, ['0.25%', '1.27%', '5.84%', '171.43%']);
    eq('reverse-ordered source gives the same returns (dates and prices stay paired)', rows['ENERGY (XLE)'].cells, rows['TECHNOLOGY (XLK)'].cells);
    eq('source sector records were not reordered or mutated', app.run("JSON.stringify(sectorData.XLE)"), JSON.stringify(sectors.XLE));
    eq('duplicate date: row is N/A on every horizon', rows['FINANCIALS (XLF)'].cells, ['N/A', 'N/A', 'N/A', 'N/A']);
    check('duplicate date: reason names the date', /duplicate date 2018-01-15/.test(rowEl('FINANCIALS').title), 'snapshot');
    eq('impossible date: row is N/A on every horizon', rows['HEALTHCARE (XLV)'].cells, ['N/A', 'N/A', 'N/A', 'N/A']);
    check('impossible date: reason names position and value', /invalid calendar date at position \d+: 2018-02-30/.test(rowEl('HEALTHCARE').title));
    eq('null record: row is N/A (no crash)', rows['CONS. DISC. (XLY)'].cells, ['N/A', 'N/A', 'N/A', 'N/A']);
    eq('commodity with a duplicate date: Gold row N/A', rows['GOLD'].cells, ['N/A', 'N/A', 'N/A', 'N/A']);
    check('commodity duplicate reason in the row tooltip', /duplicate date 2018-01-01/.test(rowEl('GOLD').title));
    eq('valid WTI row unaffected by the rejected rows', rows['WTI CRUDE'].cells, ['0.29%', '1.45%', '6.73%', '259.79%']);
    const t = rowEl('TECHNOLOGY (XLK)').title;
    check('valid row tooltip discloses the actual latest date and comparison dates',
        t.includes(`Latest observation ${SN_DATES[299]}`) && t.includes(`1D ${SN_DATES[298]}`) && t.includes(`1W ${SN_DATES[294]}`) && t.includes(`1M ${SN_DATES[277]}`) && t.includes(`1Y ${SN_DATES[47]}`) && /observation counts, not verified calendar periods/.test(t));
    check('no bad tokens in the panel', !SNAP_BAD_TOKENS.test(app.byId('sector-flow-container').children.map(c => c._html).join('')));
});

section('17j. Event <-> Latest Snapshot: snapshot chart context never leaks into event mode', async () => {
    const app = await mainApp();
    const bootMaster = ctxText(app, 'master-snapshot-context');
    const bootBaro = ctxText(app, 'barometer-snapshot-context');
    check('boot: master context shows the window and per-series baseline → last valid dates',
        bootMaster.includes('Window 5Y from 2014-12-25 (today, UTC: 2019-12-25)') && bootMaster.includes('Gold 2015-01-01 → 2019-12-25') && bootMaster.includes('WTI Crude 2015-01-01 → 2019-12-25'));
    check('boot: barometer context shows the window and last valid price', bootBaro.includes('Window 1Y from 2018-12-25: 2018-12-25 → 2019-12-25; last valid price 2019-12-25'));
    app.click(app.all('.event-btn')[0]);
    app.flush();
    check('event mode: both snapshot contexts are cleared and hidden, event subtitle shown',
        ctxText(app, 'master-snapshot-context') === '' && app.byId('master-snapshot-context').style.display === 'none' &&
        ctxText(app, 'barometer-snapshot-context') === '' && app.byId('barometer-snapshot-context').style.display === 'none' &&
        app.byId('master-chart-subtitle').textContent.startsWith('EVENT: Linear Event'));
    app.click('today-btn');
    app.flush();
    eq('back to Latest Snapshot: contexts restored exactly', [ctxText(app, 'master-snapshot-context'), ctxText(app, 'barometer-snapshot-context')], [bootMaster, bootBaro]);
    check('back to Latest Snapshot: no event text anywhere in the contexts, event subtitle hidden',
        !/EVENT|Event|Baseline:/.test(ctxText(app, 'master-snapshot-context') + ctxText(app, 'barometer-snapshot-context')) && app.byId('master-chart-subtitle').style.display === 'none');
    // rapid switching, last action wins
    app.click(app.all('.event-btn')[1]);
    app.click(app.all('.event-btn')[2]);
    app.click('today-btn');
    app.click(app.all('.event-btn')[0]);
    app.click('today-btn');
    app.flush();
    eq('rapid switching ending on Latest Snapshot: contexts equal the boot contexts', [ctxText(app, 'master-snapshot-context'), ctxText(app, 'barometer-snapshot-context')], [bootMaster, bootBaro]);
    app.click(app.all('.event-btn')[2]);
    app.click('today-btn');
    app.click(app.all('.event-btn')[1]);
    app.flush();
    check('rapid switching ending on an event: snapshot contexts hidden', app.state().active === true && ctxText(app, 'master-snapshot-context') === '' && ctxText(app, 'barometer-snapshot-context') === '');
    check('no uncaught exception in any deferred callback', app.takeTimerErrors().length === 0);
});

section('18. Sector price-definition disclosure and unavailable pre-listing ETFs (Stage 2D3)', async () => {
    const NOTE = "Sector ETF price returns use provider Close and exclude distributions. Data before each ETF's available history is unavailable.";
    // XLK has history before the first event (2015-01-05); XLRE's series begins long after it (2015-10-08).
    const sectors = {
        XLK:  weekdays('2015-01-01', 400).map((x, i) => ({ x, y: 100 + i })),
        XLRE: weekdays('2015-10-08', 300).map((x, i) => ({ x, y: 50 + i }))
    };
    const app = await loadApp({ sectors, events: EVENTS_MAIN });
    const panel = () => app.byId('sector-flow-container');
    const notes = (cls) => { const out = []; const walk = (el) => { if ((el.className || '') === cls) out.push(el); el.children.forEach(walk); }; walk(panel()); return out; };

    // Latest Snapshot (boot): disclosure visible, exact wording, details tooltip, no unavailable-event line
    check('snapshot: panel is the trailing-returns view', textOf(panel()).includes('TRAILING PRICE RETURNS'));
    eq('snapshot: exactly one disclosure line with the exact wording', notes('sector-price-definition-note').map(n => n.textContent), [NOTE]);
    check('snapshot: tooltip states auto_adjust=False and that corporate-action treatment is not verified',
        /auto_adjust=False/.test(notes('sector-price-definition-note')[0].title) && /not independently verified/.test(notes('sector-price-definition-note')[0].title));
    check('snapshot: tooltip says distributions are excluded and that the latest observation is provider-reported (not verified complete)',
        /Distributions are excluded/.test(notes('sector-price-definition-note')[0].title) && /provider-reported/.test(notes('sector-price-definition-note')[0].title));
    eq('snapshot: no "unavailable for this event" line', notes('sector-unavailable-note').length, 0);
    check('snapshot: both sector rows are still rendered', textOf(panel()).includes('TECHNOLOGY (XLK)') && textOf(panel()).includes('REAL ESTATE (XLRE)'));

    // Event mode (event 0 = 2015-01-05): disclosure visible, XLRE named as unavailable with its first date, XLK computed
    app.click(app.all('.event-btn')[0]);
    app.flush();
    check('event: panel is the retrospective view', textOf(panel()).includes('RETROSPECTIVE PRICE IMPACT'));
    eq('event: exactly one disclosure line with the exact wording', notes('sector-price-definition-note').map(n => n.textContent), [NOTE]);
    eq('event: XLRE is named as unavailable with its first data date',
        notes('sector-unavailable-note').map(n => n.textContent),
        ['Unavailable for this event (no history before it): XLRE (data begins 2015-10-08).']);
    check('event: XLRE has no return row (unchanged omission) and XLK still has one',
        !panel().children.some(c => (c._html || '').includes('REAL ESTATE (XLRE)')) && panel().children.some(c => (c._html || '').includes('TECHNOLOGY (XLK)')));
    check('event: the baseline header and rule are unchanged', textOf(panel()).includes('Baseline: last close strictly before 2015-01-05'));

    // Event -> Latest Snapshot clears event state and the event-only unavailable line, keeps the disclosure
    app.click('today-btn');
    app.flush();
    check('event -> snapshot: event state cleared', app.state().active === false && app.run('activeEventMode') === false);
    eq('event -> snapshot: disclosure still present exactly once', notes('sector-price-definition-note').map(n => n.textContent), [NOTE]);
    eq('event -> snapshot: no stale unavailable-event line', notes('sector-unavailable-note').length, 0);
    check('event -> snapshot: panel is the trailing-returns view with both rows', textOf(panel()).includes('TRAILING PRICE RETURNS') && !textOf(panel()).includes('RETROSPECTIVE') && textOf(panel()).includes('REAL ESTATE (XLRE)'));
});

section('19. Stage 2E: fetch cache, tooltip date association, single-observation disclosure', async () => {
    const app = await mbApp({ Gold: mbSeries(), 'WTI Crude': mbSeries() });
    const policyCache = app.run('DATASET_FETCH_INIT.cache');
    eq('dataset fetch uses cache: no-store (does not rely on HTTP 304)', policyCache, 'no-store');
    check('boot fetch of every runtime JSON used no-store',
        app.fetchLog.length >= 5 && app.fetchLog.every(c => c.cache === 'no-store'));
    eq('runtime JSON URLs are the saved files (no collector invocation)',
        app.fetchLog.map(c => c.url).sort(),
        ['commodities_data.json', 'equity_data.json', 'live_news.json', 'macro_events.json', 'sector_historical.json']);

    const fd = app.fn('fetchDataset');
    app.ctx.fetch = async () => ({ ok: false, status: 304 });
    const notMod = await fd('commodities_data.json');
    check('HTTP 304 is not treated as a successful body (ok is false; not assumed stale-or-fresh)',
        notMod.ok === false && notMod.error === 'HTTP 304');
    app.ctx.fetch = async () => ({ ok: false, status: 500 });
    const httpErr = await fd('commodities_data.json');
    eq('HTTP error state is preserved', httpErr, { ok: false, error: 'HTTP 500' });
    app.ctx.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
    const parseErr = await fd('commodities_data.json');
    eq('JSON parse error state is preserved', parseErr, { ok: false, error: 'JSON parse error' });
    app.ctx.fetch = async () => { throw new Error('failed to fetch'); };
    const netErr = await fd('commodities_data.json');
    eq('network error state is preserved', netErr, { ok: false, error: 'failed to fetch' });

    // Sparse Gold / Silver / Copper: index 0 is a different date on each plottable series.
    // Lumber is a single usable observation in the window (percentage comparison unavailable).
    const SIL = { labels: MB_DATES.filter((_, i) => i >= 10 && i % 2 === 0), prices: MB_DATES.map((_, i) => 200 + i).filter((_, i) => i >= 10 && i % 2 === 0) };
    const COP = { labels: ['2015-01-03', '2015-01-05', '2015-01-06'], prices: [10, 11, 12] };
    const LUM_DATE = '2015-03-15';
    const mix = await mbApp({
        Gold: mbSeries(),
        'WTI Crude': mbSeries(p => { p.forEach((_, i) => { p[i] = 50 + i; }); }),
        Silver: SIL,
        Copper: COP,
        Lumber: { labels: [LUM_DATE], prices: [380.6] }
    });
    mix.setChecked(['Gold', 'WTI Crude', 'Silver', 'Copper', 'Lumber']);
    mix.run('updateMasterChart()');
    const mc = mix.liveChart('master-canvas');
    const ixMode = mix.run('SNAPSHOT_CHART_INTERACTION.mode');
    const ixAxis = mix.run('SNAPSHOT_CHART_INTERACTION.axis');
    check('snapshot chart does not use index interaction (that pairs unlike dates by array index)',
        ixMode !== 'index' && mc.config.options.interaction.mode !== 'index' && ixAxis === 'x');
    check('tooltip filter is the production same-date helper',
        mc.config.options.plugins.tooltip.filter === mix.fn('tooltipFilterSameDate'));

    const gold = masterDs(mix, 'Gold');
    const sil = masterDs(mix, 'Silver');
    const cop = masterDs(mix, 'Copper');
    const lum = masterDs(mix, 'Lumber');
    const index0Dates = [gold.data[0].x, sil.data[0].x, cop.data[0].x];
    check('reproduced: array-index 0 is a different observation date on Gold, Silver and Copper',
        index0Dates[0] !== index0Dates[1] && index0Dates[1] !== index0Dates[2] && index0Dates[0] !== index0Dates[2]);

    const atDate = mix.fn('tooltipItemsAtDate');
    const goldDate = gold.data[0].x;
    const goldItems = atDate(mc.config.data, goldDate);
    check('tooltip at Gold\'s first date includes Gold (and WTI on that calendar) but not Silver/Copper index-0 values',
        goldItems.every(it => it.date === goldDate) &&
        goldItems.some(it => it.label === 'Gold' && it.y === 0) &&
        !goldItems.some(it => it.label === 'Silver' || it.label === 'Copper' || /^Lumber/.test(it.label)));
    const silDate = SIL.labels[1];
    const silItems = atDate(mc.config.data, silDate);
    const silPt = sil.data.find(p => p.x === silDate);
    const goldAtSilIdx = gold.data[sil.data.findIndex(p => p.x === silDate)];
    check('Silver\'s array index would have mixed Gold\'s date if associated by index',
        goldAtSilIdx && goldAtSilIdx.x !== silDate);
    check('tooltip at a Silver date uses Silver\'s own y on Silver\'s date (not Gold at that array index)',
        silItems.some(it => it.label === 'Silver' && it.y === silPt.y && it.date === silDate) &&
        silItems.every(it => it.date === silDate) &&
        !silItems.some(it => /^Lumber/.test(it.label)));
    const copItems = atDate(mc.config.data, '2015-01-03');
    check('tooltip at Copper\'s Saturday includes Copper only (Gold has no session that date)',
        copItems.length === 1 && copItems[0].label === 'Copper' && copItems[0].y === 0 && copItems[0].date === '2015-01-03');

    const lumItems = atDate(mc.config.data, LUM_DATE);
    check('Lumber\'s date is omitted from the percentage tooltip (single observation, not a 0.00% marker)',
        !lumItems.some(it => /^Lumber/.test(it.label)));
    check('Lumber stays selectable and is disclosed as single-observation unavailable',
        lum && lum.label === `Lumber (N/A: Single observation ${LUM_DATE}; return unavailable.)` && lum.data.every(p => p.y === null));
    check('no plotted Lumber point is a 0.00% return marker',
        !lum.data.some(p => p.y === 0));
    check('Gold and WTI still render next to unavailable Lumber',
        gold.data.some(p => p.y === 0) && masterDs(mix, 'WTI Crude').data.some(p => p.y === 0));

    const cb = mc.config.options.plugins.tooltip.callbacks;
    const tGold = cb.label({ dataset: gold, parsed: { y: gold.data[0].y }, label: goldDate, raw: gold.data[0] });
    check('callback at Gold\'s date names Gold and Gold\'s own price (not Silver\'s)',
        tGold.startsWith('Gold:') && tGold.includes('price return') && tGold.includes('$100.00') && !tGold.includes('Silver'));
    const filter = mix.fn('tooltipFilterSameDate');
    const mixedBundle = [
        { label: goldDate, raw: gold.data[0], parsed: { y: gold.data[0].y }, dataset: gold, dataIndex: 0 },
        { label: goldDate, raw: sil.data[0], parsed: { y: sil.data[0].y }, dataset: sil, dataIndex: 0 }
    ];
    check('filter drops the index-paired Silver point whose observation date is not the hovered date',
        filter(mixedBundle[0], 0, mixedBundle) === true && filter(mixedBundle[1], 1, mixedBundle) === false);

    const ctx = ctxText(mix, 'master-snapshot-context');
    check('context names Lumber with the single-observation phrase',
        ctx.includes(`Unavailable: Lumber (Single observation ${LUM_DATE}; return unavailable.`));

    mix.click('master-tf-MAX');
    const lumMax = masterDs(mix, 'Lumber');
    check('MAX window: Lumber remains single-observation unavailable; Gold and WTI still plot',
        lumMax.label === `Lumber (N/A: Single observation ${LUM_DATE}; return unavailable.)` &&
        masterDs(mix, 'Gold').data.some(p => typeof p.y === 'number') &&
        masterDs(mix, 'WTI Crude').data.some(p => typeof p.y === 'number'));

    mix.click('master-tf-5Y');
    check('5Y window: same Lumber disclosure; Silver still plotted',
        masterDs(mix, 'Lumber').label.includes('Single observation 2015-03-15; return unavailable.') &&
        masterDs(mix, 'Silver').data.length === SIL.labels.length);

    const emptyWin = await mbApp({
        Gold: mbSeries(),
        Lumber: { labels: ['2009-01-02'], prices: [10] }
    });
    emptyWin.setChecked(['Gold', 'Lumber']);
    emptyWin.run('updateMasterChart()');
    check('observation before the window is "no data in period", not a 0.00% return',
        masterDs(emptyWin, 'Lumber').label === 'Lumber (no data in period)' &&
        masterDs(emptyWin, 'Gold').data.some(p => p.y === 0));

    const onlyLum = await mbApp({ Lumber: { labels: [LUM_DATE], prices: [380.6] } });
    onlyLum.setChecked(['Lumber']);
    onlyLum.run('updateMasterChart()');
    const msg = onlyLum.byId('master-canvas-wrap').querySelector('.chart-no-data-msg');
    check('Lumber-only window explains the unavailable return and stays selectable',
        !!msg && /Single observation 2015-03-15; return unavailable/.test(msg.textContent) &&
        onlyLum.doc.checked.includes('Lumber'));
});

// ============================================================
// RUN
// ============================================================
(async function main() {
    for (const s of sections) {
        currentSection = s.name;
        console.log(`\n── ${s.name} ──`);
        try {
            await s.fn();
        } catch (err) {
            if (/^Harness sanity/.test(s.name)) {
                console.error(`HARNESS FAILURE in sanity section: ${err && err.stack || err}`);
                process.exit(2);
            }
            check(`section threw an exception: ${err && err.message}`, false);
            console.error(String(err && err.stack || err).split('\n').slice(0, 6).join('\n'));
        }
        // Any deferred-callback exception not explicitly claimed by the section is a failure.
        createdApps.splice(0).forEach(a => a.takeTimerErrors().forEach(e =>
            check(`uncaught exception in a deferred callback: ${e && e.message}`, false)));
    }

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        const tagged = failures.filter(f => f.defectId);
        const untagged = failures.filter(f => !f.defectId);
        if (tagged.length) {
            console.error('\nSuspected production defects (preserved regressions):');
            tagged.forEach(f => console.error(`  • [${f.defectId}] ${f.section}: ${f.description}`));
        }
        if (untagged.length) {
            console.error('\nOther failed assertions:');
            untagged.forEach(f => console.error(`  • ${f.section}: ${f.description}`));
        }
        console.error('\nReminder: mocks are not visual browser verification.');
        process.exit(1);
    }
    console.log('All tests passed.');
    console.log('Reminder: mocks are not visual browser verification.');
    process.exit(0);
})();
