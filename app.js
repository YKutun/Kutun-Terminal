// ============================================================
// app.js — Kutun Terminal | Commodity Data Engine
// ============================================================

// Global store for all commodity data loaded from JSON
let commodityData = {};

// Currently selected commodity for the Geopolitical Barometer
let activeBarometerTicker = null;
let activeBarometerTimeframe = '1Y';

// Master chart (FX tab) timeframe state
let activeMasterTimeframe = '5Y';

// Chart instances (kept so we can destroy and re-create cleanly)
let barometerChart = null;
let masterChart = null;

// ============================================================
// 1. DATA LOADING — Fetch commodities_data.json at startup
// ============================================================
async function loadCommodityData() {
    try {
        const response = await fetch('commodities_data.json');
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        commodityData = await response.json();
        console.log(`Loaded ${Object.keys(commodityData).length} commodities.`);

        // Populate UI elements once data is loaded
        buildBarometerList();
        buildMasterCheckboxes();

        // Auto-select the first commodity for the barometer
        const firstTicker = Object.keys(commodityData)[0];
        if (firstTicker) selectBarometerCommodity(firstTicker);

    } catch (err) {
        console.error('Failed to load commodities_data.json:', err);
        document.getElementById('barometer-list').innerHTML =
            '<p style="color:#ff4c4c;padding:10px;">Error: Could not load data.<br>Run: <b>py -m http.server 8080</b></p>';
    }
}

// ============================================================
// 2. UTILITY — Slice data arrays by timeframe
// ============================================================
function sliceByTimeframe(labels, prices, timeframe) {
    const now = new Date();
    let cutoff;

    switch (timeframe) {
        case '1W': cutoff = new Date(now - 7 * 86400000); break;
        case '1M': cutoff = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()); break;
        case '3M': cutoff = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()); break;
        case '6M': cutoff = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()); break;
        case 'YTD': cutoff = new Date(now.getFullYear(), 0, 1); break;
        case '1Y': cutoff = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()); break;
        case '5Y':
        default: cutoff = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate()); break;
    }

    const startIdx = labels.findIndex(d => new Date(d) >= cutoff);
    if (startIdx === -1) return { labels, prices };
    return {
        labels: labels.slice(startIdx),
        prices: prices.slice(startIdx)
    };
}

// ============================================================
// 3. GEOPOLITICAL BAROMETER — Commodity list + single chart
// ============================================================
function buildBarometerList() {
    const list = document.getElementById('barometer-list');
    list.innerHTML = '';
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

    // Update highlighted item in list
    document.querySelectorAll('.commodity-item').forEach(el => el.classList.remove('active'));
    const activeEl = document.getElementById(`bitem-${name.replace(/\s+/g, '-')}`);
    if (activeEl) activeEl.classList.add('active');

    renderBarometerChart(name, activeBarometerTimeframe);
}

function setBarometerTimeframe(tf) {
    activeBarometerTimeframe = tf;

    // Update button styles — only target barometer buttons (prefixed baro-tf-)
    document.querySelectorAll('.baro-tf-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`baro-tf-${tf}`).classList.add('active');

    if (activeBarometerTicker) renderBarometerChart(activeBarometerTicker, tf);
}

function setMasterTimeframe(tf) {
    activeMasterTimeframe = tf;

    // Update master timeframe button styles (prefixed master-tf-)
    document.querySelectorAll('.master-tf-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`master-tf-${tf}`).classList.add('active');

    updateMasterChart();
}

function renderBarometerChart(name, timeframe) {
    const dataset = commodityData[name];
    if (!dataset) return;

    const sliced = sliceByTimeframe(dataset.labels, dataset.prices, timeframe);

    // Destroy existing chart before creating a new one
    if (barometerChart) {
        barometerChart.destroy();
        barometerChart = null;
    }

    const ctx = document.getElementById('barometer-canvas').getContext('2d');
    barometerChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: sliced.labels,
            datasets: [{
                label: name,
                data: sliced.prices,
                borderColor: '#00d1ff',
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.1,
                fill: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: $${ctx.parsed.y.toFixed(2)}`
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#666', maxTicksLimit: 6, font: { family: 'Roboto Mono', size: 10 } },
                    grid: { color: '#1a1a1a' }
                },
                y: {
                    ticks: { color: '#666', font: { family: 'Roboto Mono', size: 10 } },
                    grid: { color: '#1a1a1a' }
                }
            }
        }
    });

    // Update chart title
    document.getElementById('barometer-chart-title').textContent = name.toUpperCase();
}

// ============================================================
// 4. MASTER CHART (FX Tab) — Multi-series % normalized overlay
// ============================================================

// Color palette for up to 14 series
const CHART_COLORS = [
    '#00d1ff', '#00ff00', '#ffb800', '#ff4c4c', '#a855f7',
    '#f97316', '#ec4899', '#14b8a6', '#84cc16', '#eab308',
    '#6366f1', '#06b6d4', '#8b5cf6', '#d946ef'
];

// Store raw prices per label so tooltip can show absolute value alongside %
let masterRawPrices = {}; // { "Gold": { "2024-01-02": 2050.40, ... }, ... }

function buildMasterCheckboxes() {
    const container = document.getElementById('master-checkboxes');
    container.innerHTML = '';
    Object.keys(commodityData).forEach((name, i) => {
        const color = CHART_COLORS[i % CHART_COLORS.length];
        const label = document.createElement('label');
        label.className = 'checkbox-label';
        label.innerHTML = `
            <input type="checkbox" value="${name}" onchange="updateMasterChart()">
            <span style="color:${color}">${name}</span>`;
        container.appendChild(label);
    });
}

/**
 * Converts an array of absolute prices to % change from the first value.
 * e.g. [2000, 2100, 1900] → [0, +5.00, -5.00]
 */
function toPercentChange(prices) {
    if (!prices || prices.length === 0) return [];
    const base = prices[0];
    if (base === 0) return prices.map(() => 0);
    return prices.map(p => parseFloat(((p - base) / base * 100).toFixed(3)));
}

function updateMasterChart() {
    const checked = Array.from(document.querySelectorAll('#master-checkboxes input:checked'))
        .map(cb => cb.value);

    if (masterChart) {
        masterChart.destroy();
        masterChart = null;
    }

    if (checked.length === 0) return;

    masterRawPrices = {}; // reset raw price lookup

    const datasets = checked.map((name) => {
        const dataset = commodityData[name];
        const sliced = sliceByTimeframe(dataset.labels, dataset.prices, activeMasterTimeframe);

        // Store raw prices keyed by date for tooltip access
        masterRawPrices[name] = {};
        sliced.labels.forEach((d, i) => { masterRawPrices[name][d] = sliced.prices[i]; });

        // Normalize to percentage change from start of timeframe window
        const pctData = toPercentChange(sliced.prices);

        return {
            label: name,
            data: pctData.map((p, idx) => ({ x: sliced.labels[idx], y: p })),
            borderColor: CHART_COLORS[Object.keys(commodityData).indexOf(name) % CHART_COLORS.length],
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.1,
            fill: false
        };
    });

    const ctx = document.getElementById('master-canvas').getContext('2d');
    masterChart = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: '#aaa', font: { family: 'Roboto Mono', size: 11 }, boxWidth: 12 }
                },
                tooltip: {
                    callbacks: {
                        // Show both % change AND absolute price
                        label: ctx => {
                            const name = ctx.dataset.label;
                            const pct = ctx.parsed.y;
                            const date = ctx.label;
                            const raw = masterRawPrices[name]?.[date];
                            const rawStr = raw != null ? `  ($${raw.toFixed(2)})` : '';
                            const sign = pct >= 0 ? '+' : '';
                            return `${name}: ${sign}${pct.toFixed(2)}%${rawStr}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'category',
                    ticks: { color: '#666', maxTicksLimit: 8, font: { family: 'Roboto Mono', size: 10 } },
                    grid: { color: '#1a1a1a' }
                },
                y: {
                    ticks: {
                        color: '#666',
                        font: { family: 'Roboto Mono', size: 10 },
                        // Append % symbol to Y-axis tick labels
                        callback: val => `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`
                    },
                    grid: { color: '#1a1a1a' }
                }
            }
        }
    });
}

// ============================================================
// 5. TAB NAVIGATION
// ============================================================
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    const indexMap = { kutun: 0, macro: 1, equity: 2, valuation: 3, fx: 4, digital: 5, portfolio: 6 };
    document.querySelectorAll('.nav-item')[indexMap[tabId]]?.classList.add('active');
}

// ============================================================
// 6. INIT — Load data when page is ready
// ============================================================
document.addEventListener('DOMContentLoaded', loadCommodityData);
