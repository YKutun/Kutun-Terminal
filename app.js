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
let activeCustomRange = null; // { start: Date, end: Date } for event snapping

// Data stores
let macroEvents = [];
let sectorData = {};
let equityData = {}; // New global for Equity Terminal
let activeEventIdx = null; // Track currently selected historical event
let activeEquityTicker = null; // Currently selected stock in Equity Terminal

// Sector Mapping Dictionary
const SECTOR_MAP = {
    'XLK': 'TECHNOLOGY (XLK)', 'XLE': 'ENERGY (XLE)', 'XLF': 'FINANCIALS (XLF)', 
    'XLV': 'HEALTHCARE (XLV)', 'XLY': 'CONS. DISC. (XLY)', 'XLI': 'INDUSTRIALS (XLI)', 
    'XLB': 'MATERIALS (XLB)', 'XLU': 'UTILITIES (XLU)', 'XLP': 'CONS. STAPLES (XLP)', 
    'XLRE': 'REAL ESTATE (XLRE)', 'XLC': 'COMM. SVCS (XLC)'
};

// Chart instances (kept so we can destroy and re-create cleanly)
let barometerChart = null;
let masterChart = null;
let equityChart = null; // New global for Equity Chart

// ============================================================
/// ============================================================
// 1. INITIALIZATION — Linear boot sequence
// ============================================================
async function initTerminal() {
    try {
        console.log("Initializing Terminal Engine...");
        
        // 1. Fetch all static data safely
        const fetchSafe = async (url, defaultData) => {
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return await res.json();
            } catch (e) {
                console.warn(`Failed to safely load ${url}:`, e);
                return defaultData;
            }
        };

        const [commodRes, eventRes, sectorRes, newsRes, equityRes] = await Promise.all([
            fetchSafe('commodities_data.json', {}),
            fetchSafe('macro_events.json', []),
            fetchSafe('sector_historical.json', {}),
            fetchSafe('live_news.json', []),
            fetchSafe('equity_data.json', {})
        ]);

        // 2. Apply Data
        commodityData = commodRes;
        macroEvents = eventRes;
        sectorData = sectorRes;
        equityData = equityRes;
        const newsData = newsRes;

        // 3. Build UI components (Stateless/Data-driven)
        buildBarometerList();
        buildMasterCheckboxes();
        renderLiveNews(newsData);
        buildMacroEventList();
        buildMacroArchive(); // New UI builder for Macro tab
        buildEquityWatchlist(); // New UI builder

        // 4. Set Initial State (Today's Market)
        resetToToday();

        // 5. Default selection
        const firstTicker = Object.keys(commodityData)[0];
        if (firstTicker) selectBarometerCommodity(firstTicker);

        console.log("Terminal initialized successfully.");
    } catch (err) {
        console.error('Terminal Initialization Failed (Fatal):', err);
    }
}
// ============================================================
// 2. UTILITY — Slice data arrays by timeframe
// ============================================================
function sliceByTimeframe(labels, prices, timeframe) {
    if (activeCustomRange) {
        const { start, end } = activeCustomRange;
        const startIdx = labels.findIndex(d => new Date(d) >= start);
        const endIdx = labels.findLastIndex(d => new Date(d) <= end);
        if (startIdx === -1) return { labels: [], prices: [] };
        const safeEnd = endIdx === -1 ? labels.length : endIdx + 1;
        return {
            labels: labels.slice(startIdx, safeEnd),
            prices: prices.slice(startIdx, safeEnd)
        };
    }

    const now = new Date();
    let cutoff;

    switch (timeframe) {
        case '1W': cutoff = new Date(now - 7 * 86400000); break;
        case '1M': cutoff = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()); break;
        case '3M': cutoff = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()); break;
        case '6M': cutoff = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()); break;
        case 'YTD': cutoff = new Date(now.getFullYear(), 0, 1); break;
        case '1Y': cutoff = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()); break;
        case '5Y': cutoff = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate()); break;
        case 'MAX': cutoff = new Date('2005-01-01'); break;
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

    // Clear active custom range when switching timeframe buttons
    activeCustomRange = null;
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
                fill: false,
                spanGaps: true
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
    // Find the first valid (non-null, non-zero) price to use as baseline
    const base = prices.find(p => p !== null && p !== undefined && p !== 0);
    if (!base) return prices.map(() => 0);
    return prices.map(p => (p === null || p === undefined) ? null : parseFloat(((p - base) / base * 100).toFixed(3)));
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

    // 1. Extract all raw datasets for the selected timeframe
    const rawDatasets = checked.map(name => {
        const dataset = commodityData[name];
        const sliced = sliceByTimeframe(dataset.labels, dataset.prices, activeMasterTimeframe);
        return { name, labels: sliced.labels, prices: sliced.prices };
    });

    // 2. Create a unified MASTER labels (dates) array
    const allDates = new Set();
    rawDatasets.forEach(rd => rd.labels.forEach(d => allDates.add(d)));
    const masterLabels = Array.from(allDates).sort();

    // 3. Align each dataset to the master labels with null padding
    const datasets = rawDatasets.map((rd) => {
        const { name, labels, prices } = rd;
        const alignedPrices = [];
        const datePriceMap = {};
        labels.forEach((d, i) => { datePriceMap[d] = prices[i]; });

        masterLabels.forEach(date => {
            const p = datePriceMap[date];
            alignedPrices.push(p !== undefined ? p : null);
        });

        // Store raw prices for tooltip access
        masterRawPrices[name] = datePriceMap;

        // Calculate % change relative to the first available valid price in THIS timeframe
        const pctData = toPercentChange(alignedPrices);

        return {
            label: name,
            data: pctData.map((p, idx) => ({ x: masterLabels[idx], y: p })),
            borderColor: CHART_COLORS[Object.keys(commodityData).indexOf(name) % CHART_COLORS.length],
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.1,
            fill: false,
            spanGaps: true
        };
    });

    const ctx = document.getElementById('master-canvas').getContext('2d');
    masterChart = new Chart(ctx, {
        type: 'line',
        data: { labels: masterLabels, datasets },
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
// 5. LIVE NEWS ENGINE — Fetch and render news
// ============================================================
async function fetchLiveNews() {
    try {
        const response = await fetch('live_news.json');
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const news = await response.json();
        renderLiveNews(news);
    } catch (err) {
        console.error('Failed to load live_news.json:', err);
        const errorMsg = '<div class="news-item">Error loading news feed.</div>';
        const gFeed = document.getElementById('global-news-feed');
        const mFeed = document.getElementById('macro-news-full');
        if (gFeed) gFeed.innerHTML = errorMsg;
        if (mFeed) mFeed.innerHTML = errorMsg;
    }
}

function renderLiveNews(newsItems) {
    const globalContainer = document.getElementById('global-news-feed');
    const macroContainer = document.getElementById('macro-news-full');

    const renderToContainer = (container, items) => {
        if (!container) return;
        container.innerHTML = '';
        if (items.length === 0) {
            container.innerHTML = '<div class="news-item">No news available.</div>';
            return;
        }

        items.forEach((item) => {
            const newsItem = document.createElement('div');
            newsItem.className = 'news-item';
            
            let timeStr = "";
            try {
                const date = new Date(item.published_at);
                timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            } catch (e) {
                timeStr = "--:--";
            }

            const highImpactKeywords = ['CRASH', 'WAR', 'FED', 'INFLATION', 'SELL-OFF', 'RATE', 'TREASURY'];
            const headline = item.headline.toUpperCase();
            const isHighImpact = highImpactKeywords.some(kw => headline.includes(kw));
            const impactBadge = isHighImpact ? '<span class="impact-badge" style="margin-right: 10px;">HIGH IMPACT</span>' : '';

            newsItem.innerHTML = `
                <div style="display:flex; align-items:center; gap:8px;">
                    <span class="news-time">${timeStr}</span>
                    ${impactBadge}
                </div>
                <a href="${item.link}" target="_blank">${headline}</a>
            `;
            container.appendChild(newsItem);
        });
    };

    // Global Feed (Overview): limit to 7
    renderToContainer(globalContainer, newsItems.slice(0, 7));
    
    // Macro Feed (Deep Dive): show all 50
    renderToContainer(macroContainer, newsItems);
}

// ============================================================
// 6. HISTORICAL IMPACT ENGINE
// ============================================================
function buildMacroEventList() {
    const container = document.getElementById('event-list-container');
    if (!container) return;
    container.innerHTML = '';
    
    macroEvents.forEach((ev, idx) => {
        const btn = document.createElement('div');
        btn.className = 'event-btn';
        btn.textContent = `${ev.date} | ${ev.name}`;
        btn.onclick = () => handleEventSelection(idx);
        container.appendChild(btn);
    });
}

function buildMacroArchive() {
    const container = document.getElementById('macro-archive-container');
    if (!container) return;
    container.innerHTML = '';

    macroEvents.forEach((ev, idx) => {
        const card = document.createElement('div');
        card.className = 'macro-event-card';
        
        card.innerHTML = `
            <div class="macro-event-header" onclick="this.parentElement.classList.toggle('expanded')">
                <span class="macro-event-date">${ev.date}</span>
                <span class="macro-event-title">${ev.name}</span>
            </div>
            <div class="macro-event-body">
                ${ev.description}
            </div>
        `;
        container.appendChild(card);
    });
}

function resetToToday() {
    activeEventIdx = null;
    activeCustomRange = null;
    
    // Clear active states in list
    document.querySelectorAll('.event-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('today-btn').classList.add('active');
    
    // Reset Q2 Chart to 1Y View
    updateMasterChart(); // Will use default range (1Y)
    
    // Update Q3 & Q4 for "Today"
    calculateSectorSnapshot(); 
    calculateImpactMetrics(null); // Passing null for 'Today'
}

function handleEventSelection(idx) {
    activeEventIdx = idx;
    const event = macroEvents[idx];
    const eventDate = new Date(event.date);

    // Update UI highlights
    document.querySelectorAll('.event-btn').forEach((b, i) => {
        b.classList.toggle('active', i === idx);
    });
    document.getElementById('today-btn').classList.remove('active');

    // 1. Set Custom Range: 7 days before to 30 days after
    const start = new Date(eventDate); start.setDate(start.getDate() - 7);
    const end = new Date(eventDate); end.setDate(end.getDate() + 30);
    activeCustomRange = { start, end };

    // Update charts instantly
    updateMasterChart();
    if (activeBarometerTicker) {
        renderBarometerChart(activeBarometerTicker, activeBarometerTimeframe);
    }

    // 2. Calculate Impacts
    setTimeout(() => {
        calculateImpactMetrics(event.date);
        calculateSectorBacktest(event.date);
    }, 100);
}

// (Sector Data is now loaded in initTerminal)

function calculateSectorBacktest(targetDateStr) {
    if (!sectorData || Object.keys(sectorData).length === 0) return;

    const sectorContainer = document.getElementById('sector-flow-container');
    if (!sectorContainer) return;

    const eventDate = new Date(targetDateStr);
    const endWindow = new Date(eventDate);
    endWindow.setDate(endWindow.getDate() + 30);

    const results = [];

    Object.entries(sectorData).forEach(([ticker, data]) => {
        // data is [{x: "YYYY-MM-DD", y: price}, ...]
        const tIdx = data.findIndex(d => new Date(d.x) >= eventDate);
        if (tIdx === -1) return;

        const pT = data[tIdx].y;
        
        // Find price closest to T+30
        const t30Idx = data.findLastIndex(d => new Date(d.x) <= endWindow);
        if (t30Idx === -1 || t30Idx <= tIdx) return;

        const pT30 = data[t30Idx].y;
        const change = ((pT30 - pT) / pT * 100).toFixed(2);
        
        results.push({
            ticker,
            change: parseFloat(change),
            formatted: (change >= 0 ? '+' : '') + change + '%'
        });
    });

    // 1. Render Sectors in FIXED order
    sectorContainer.innerHTML = '';
    
    Object.entries(SECTOR_MAP).forEach(([ticker, displayName], i) => {
        const sectorRaw = sectorData[ticker];
        if (!sectorRaw) return;

        const tIdx = sectorRaw.findIndex(d => new Date(d.x) >= eventDate);
        if (tIdx === -1) return;

        const pT = sectorRaw[tIdx].y;
        
        // 1D Change
        let d1Markup = "N/A";
        if (sectorRaw[tIdx + 1]) {
            const pct = ((sectorRaw[tIdx+1].y - pT) / pT * 100).toFixed(2);
            d1Markup = `<span style="color:${pct >= 0 ? 'var(--green)' : 'var(--red)'}">${pct}%</span>`;
        }

        // 1W Change (T+5)
        let w1Markup = "N/A";
        if (sectorRaw[tIdx + 5]) {
            const pct = ((sectorRaw[tIdx+5].y - pT) / pT * 100);
            w1Markup = `<span style="color:${pct >= 0 ? 'var(--green)' : 'var(--red)'}">${pct.toFixed(2)}%</span>`;
        }
        
        // 1M Change (T+30 approx)
        const t30Idx = sectorRaw.findLastIndex(d => new Date(d.x) <= endWindow);
        let m1Markup = "N/A";
        if (t30Idx !== -1 && t30Idx > tIdx) {
            const pct = ((sectorRaw[t30Idx].y - pT) / pT * 100);
            m1Markup = `<span style="color:${pct >= 0 ? 'var(--green)' : 'var(--red)'}">${pct.toFixed(2)}%</span>`;
        }

        const row = document.createElement('div');
        row.className = 'metric-row';
        row.style.fontSize = "0.9rem";
        row.style.padding = "4px 10px";
        row.innerHTML = `
            <span class="metric-label" style="width: 170px; flex-shrink: 0;">${displayName}</span>
            <span style="width: 110px; flex-shrink: 0;">1D: ${d1Markup}</span>
            <span style="width: 110px; flex-shrink: 0;">1W: ${w1Markup}</span>
            <span style="width: 110px; flex-shrink: 0;">1M: ${m1Markup}</span>
        `;
        sectorContainer.appendChild(row);
    });

    // 2. Add Separator and Commodities (Gold & Oil)
    const separator = document.createElement('div');
    separator.style = "border-top: 1px solid #333; margin: 8px 0; padding-top: 8px; font-size: 0.7rem; color: #444; padding-left: 10px; letter-spacing: 1px;";
    separator.textContent = "COMMODITY IMPACT";
    sectorContainer.appendChild(separator);

    const commoditiesToTrack = ['Gold', 'WTI Crude'];
    commoditiesToTrack.forEach(name => {
        const dataset = commodityData[name];
        if (!dataset) return;

        const allDates = dataset.labels;
        const prices = dataset.prices;
        const tIdx = allDates.findIndex(d => new Date(d) >= eventDate);
        if (tIdx === -1) return;

        const pT = prices[tIdx];
        
        const calcImpact = (offset) => {
            if (!prices[tIdx + offset]) return "N/A";
            const pct = ((prices[tIdx + offset] - pT) / pT * 100);
            return `<span style="color:${pct >= 0 ? 'var(--green)' : 'var(--red)'}">${pct.toFixed(2)}%</span>`;
        };

        const row = document.createElement('div');
        row.className = 'metric-row';
        row.innerHTML = `
            <span class="metric-label" style="width: 170px; flex-shrink: 0; color: var(--amber);">${name.toUpperCase()}</span>
            <span style="width: 110px; flex-shrink: 0;">1D: ${calcImpact(1)}</span>
            <span style="width: 110px; flex-shrink: 0;">1W: ${calcImpact(5)}</span>
            <span style="width: 110px; flex-shrink: 0;">1M: ${calcImpact(22)}</span>
        `;
        sectorContainer.appendChild(row);
    });
}

function calculateSectorSnapshot() {
    // Shows "Today's" Trailing 1D, 1W, 1M for Sectors + Commodities
    const sectorContainer = document.getElementById('sector-flow-container');
    if (!sectorContainer) return;
    sectorContainer.innerHTML = '';

    Object.entries(SECTOR_MAP).forEach(([ticker, displayName]) => {
        const data = sectorData[ticker];
        if (!data || data.length < 30) return;

        const pT = data[data.length - 1].y;
        const p1D = data[data.length - 2].y;
        const p1W = data[data.length - 6].y;
        const p1M = data[data.length - 23].y;

        const calc = (cur, old) => {
            const pct = ((cur - old) / old * 100);
            return `<span style="color:${pct >= 0 ? 'var(--green)' : 'var(--red)'}">${pct.toFixed(2)}%</span>`;
        };

        const row = document.createElement('div');
        row.className = 'metric-row';
        row.innerHTML = `
            <span class="metric-label" style="width: 170px; flex-shrink: 0;">${displayName}</span>
            <span style="width: 110px; flex-shrink: 0;">1D: ${calc(pT, p1D)}</span>
            <span style="width: 110px; flex-shrink: 0;">1W: ${calc(pT, p1W)}</span>
            <span style="width: 110px; flex-shrink: 0;">1M: ${calc(pT, p1M)}</span>
        `;
        sectorContainer.appendChild(row);
    });

    const separator = document.createElement('div');
    separator.style = "border-top: 1px solid #333; margin: 8px 0; padding-top: 8px; font-size: 0.7rem; color: #444; padding-left: 10px; letter-spacing: 1px;";
    separator.textContent = "COMMODITY METRICS";
    sectorContainer.appendChild(separator);

    ['Gold', 'WTI Crude'].forEach(name => {
        const dataset = commodityData[name];
        if (!dataset) return;
        const prices = dataset.prices;
        const pT = prices[prices.length - 1];
        
        const calc = (cur, old) => {
            if (!old) return "N/A";
            const pct = ((cur - old) / old * 100);
            return `<span style="color:${pct >= 0 ? 'var(--green)' : 'var(--red)'}">${pct.toFixed(2)}%</span>`;
        };

        const row = document.createElement('div');
        row.className = 'metric-row';
        row.innerHTML = `
            <span class="metric-label" style="width: 170px; flex-shrink: 0; color: var(--amber);">${name.toUpperCase()}</span>
            <span style="width: 110px; flex-shrink: 0;">1D: ${calc(pT, prices[prices.length-2])}</span>
            <span style="width: 110px; flex-shrink: 0;">1W: ${calc(pT, prices[prices.length-6])}</span>
            <span style="width: 110px; flex-shrink: 0;">1M: ${calc(pT, prices[prices.length-23])}</span>
        `;
        sectorContainer.appendChild(row);
    });
}

function calculateImpactMetrics(targetDateStr) {
    const container = document.getElementById('impact-metrics-container');
    container.innerHTML = '';
    
    if (!targetDateStr) {
        container.innerHTML = '<p class="placeholder" style="margin-top:20px;">TODAY\'S MARKET SNAPSHOT ACTIVE.<br>SELECT HISTORICAL EVENT TO VIEW BACKTEST WINNERS.</p>';
        return;
    }

    const allCommodities = Object.entries(commodityData);
    const eventDateStr = targetDateStr;
    const allDates = Array.from(new Set(Object.values(commodityData).flatMap(d => d.labels))).sort();
    const tIdx = allDates.findIndex(d => d >= eventDateStr);
    
    if (tIdx === -1) return;

    const impacts = [];

    allCommodities.forEach(([name, dataset]) => {
        const datePriceMap = {};
        dataset.labels.forEach((d, i) => { datePriceMap[d] = dataset.prices[i]; });

        const pT = datePriceMap[allDates[tIdx]];
        const pT1 = datePriceMap[allDates[tIdx + 1]];
        const pT7 = datePriceMap[allDates[tIdx + 5]];

        if (pT != null && pT7 != null) {
            const w1Change = ((pT7 - pT) / pT * 100);
            const d1Change = pT1 != null ? ((pT1 - pT) / pT * 100) : null;
            impacts.push({ name, w1Change, d1Change });
        }
    });

    if (impacts.length === 0) return;

    impacts.sort((a, b) => b.w1Change - a.w1Change);
    const winner = impacts[0];
    const loser = impacts[impacts.length - 1];

    const renderBox = (data, type) => {
        const sign = data.w1Change >= 0 ? '+' : '';
        const color = data.w1Change >= 0 ? 'var(--green)' : 'var(--red)';
        const label = type === 'winner' ? 'TOP PERFORMER' : 'MAX DRAWDOWN';
        return `
            <div class="wl-box ${type}">
                <span class="wl-label">${label}</span>
                <span class="wl-name" style="color:${color}">${data.name.toUpperCase()}</span>
                <span class="wl-stats">1W RETURN: ${sign}${data.w1Change.toFixed(2)}%</span>
            </div>
        `;
    };

    const wlContainer = document.createElement('div');
    wlContainer.className = 'wl-container';
    wlContainer.innerHTML = renderBox(winner, 'winner') + renderBox(loser, 'loser');
    container.appendChild(wlContainer);
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

    // Trigger default load for Equity Terminal if not already set
    if (tabId === 'equity' && !activeEquityTicker && equityData['RY.TO']) {
        selectEquityTicker('RY.TO');
    }
}

// ============================================================
// 8. EQUITY TERMINAL LOGIC
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
    // 1. Populate Sectors Dynamically
    const sectorSelect = document.getElementById('filter-sector');
    if (sectorSelect) {
        const sectors = new Set();
        Object.values(equityData).forEach(data => {
            if (typeof data !== 'string' && data.metadata && data.metadata.sector && data.metadata.sector !== 'N/A') {
                sectors.add(data.metadata.sector);
            }
        });
        const sortedSectors = Array.from(sectors).sort();
        sectorSelect.innerHTML = '<option value="ALL">All Sectors</option>';
        sortedSectors.forEach(sec => {
            const opt = document.createElement('option');
            opt.value = sec;
            opt.textContent = sec;
            sectorSelect.appendChild(opt);
        });
    }

    // 2. Render List Based on Filters
    renderEquityWatchlist();
}

function renderEquityWatchlist() {
    const container = document.getElementById('equity-watchlist');
    if (!container) return;
    container.innerHTML = '';

    const allTickers = Object.keys(equityData);
    let filteredTickers = allTickers.filter(symbol => {
        const data = equityData[symbol];
        if (typeof data === 'string') return false; // skip error
        
        // Region Filter
        const isCan = symbol.endsWith('.TO');
        if (activeEquityRegion === 'US' && isCan) return false;
        if (activeEquityRegion === 'CAN' && !isCan) return false;
        
        // Sector Filter
        if (activeEquitySector !== 'ALL') {
            if (data.metadata?.sector !== activeEquitySector) return false;
        }
        
        return true;
    });

    if (filteredTickers.length === 0) {
        container.innerHTML = '<div style="padding: 20px; color: #666; text-align: center;">No tickers match criteria.</div>';
        return;
    }

    filteredTickers.forEach(symbol => {
        const data = equityData[symbol];
        const row = document.createElement('div');
        row.className = 'watchlist-item';
        if (symbol === activeEquityTicker) row.classList.add('active');
        row.id = `watchlist-${symbol.replace('.', '-')}`;
        row.onclick = () => selectEquityTicker(symbol);

        const name = data.metadata?.longName || symbol;
        
        row.innerHTML = `
            <span class="watchlist-ticker">${symbol}</span>
            <span class="watchlist-name">${name}</span>
        `;
        container.appendChild(row);
    });

    // Handle Active Ticker falling outside of filters
    if (activeEquityTicker && !filteredTickers.includes(activeEquityTicker)) {
        selectEquityTicker(filteredTickers[0]);
    } else if (!activeEquityTicker && filteredTickers.length > 0) {
        selectEquityTicker(filteredTickers[0]);
    }
}

function selectEquityTicker(symbol) {
    activeEquityTicker = symbol;
    const data = equityData[symbol];
    if (!data || typeof data === 'string') return;

    // 1. Update active state in UI
    document.querySelectorAll('.watchlist-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`watchlist-${symbol.replace('.', '-')}`)?.classList.add('active');

    // 2. Update Header
    document.getElementById('equity-main-ticker').textContent = symbol;
    document.getElementById('equity-main-name').textContent = data.metadata.longName;

    // 3. Update Summary & Stats
    document.getElementById('equity-summary').textContent = data.metadata.longBusinessSummary;
    
    const format = (val, prefix = '$') => (val === 'N/A' || val == null) ? 'N/A' : `${prefix}${val.toLocaleString()}`;
    const formatSmall = (val) => (val === 'N/A' || val == null) ? 'N/A' : val.toLocaleString();

    document.getElementById('stat-price').textContent = format(data.metadata.currentPrice);
    document.getElementById('stat-mcap').textContent = data.metadata.marketCap !== 'N/A' ? '$' + (data.metadata.marketCap / 1e12).toFixed(2) + 'T' : 'N/A';
    document.getElementById('stat-pe').textContent = formatSmall(data.metadata.trailingPE);
    document.getElementById('stat-sector').textContent = data.metadata.sector;
    document.getElementById('stat-52h').textContent = format(data.metadata.fiftyTwoWeekHigh);
    document.getElementById('stat-52l').textContent = format(data.metadata.fiftyTwoWeekLow);

    // 4. Render Chart
    renderEquityChart(symbol);
}

function renderEquityChart(symbol) {
    const data = equityData[symbol];
    if (!data || !data.historical_prices || data.historical_prices === 'N/A') return;

    const labels = Object.keys(data.historical_prices);
    const prices = Object.values(data.historical_prices);

    if (equityChart) {
        equityChart.destroy();
    }

    const ctx = document.getElementById('equity-canvas').getContext('2d');
    equityChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Price',
                data: prices,
                borderColor: '#00ff00',
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0,
                fill: true,
                backgroundColor: 'rgba(0, 255, 0, 0.05)'
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
                        label: ctx => `Price: $${ctx.parsed.y.toFixed(2)}`
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#666', maxTicksLimit: 12, font: { family: 'Roboto Mono', size: 10 } },
                    grid: { color: '#1a1a1a' }
                },
                y: {
                    ticks: { color: '#666', font: { family: 'Roboto Mono', size: 10 } },
                    grid: { color: '#1a1a1a' }
                }
            }
        }
    });
}

// ============================================================
// 6. INIT — Load data when page is ready
// ============================================================
document.addEventListener('DOMContentLoaded', initTerminal);
