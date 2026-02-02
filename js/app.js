/**
 * RURAL EXPLORER — app.js  v2.4
 * ============================================================
 * ROOT CAUSE OF "INITIALIZING SYSTEM..." HANG (fixed in v2.4):
 *
 *   window.addEventListener('load', …) waits for EVERY resource
 *   on the page — every CDN script, every image, every stylesheet.
 *   If any single CDN (Tailwind, Chart.js, SheetJS, Leaflet) is
 *   slow or stalls, the 'load' event never fires and the entire
 *   app never boots.  The screenshot confirmed this: the HTML
 *   rendered (header visible) but the status never left
 *   "INITIALIZING SYSTEM..." because the load handler never ran.
 *
 *   Fix: replaced window 'load' with document 'DOMContentLoaded'.
 *   This fires as soon as the HTML is parsed — it does NOT wait
 *   for external scripts or images.  We then check that each
 *   dependency (L, Chart, XLSX) actually exists before using it,
 *   and retry with short delays if they haven't arrived yet.
 *
 * Previous fixes retained:
 *   - Exact column-header mapping for the spreadsheet
 *   - =HYPERLINK() formula extraction for real URLs
 *   - OpenStreetMap tiles
 *   - Multi-path fetch fallback
 *   - 15 s watchdog timeout
 * ============================================================
 */

// ---------------------------------------------------------------------------
// 1. GLOBAL STATE
// ---------------------------------------------------------------------------
let currentData   = [];
let chartInstance  = null;
let map            = null;
let markers        = null;
let loadTimeout    = null;

// ---------------------------------------------------------------------------
// 2. DEPENDENCY CHECKER
//    Returns a promise that resolves once all three globals exist,
//    or rejects after 10 s.  This decouples us from script load order.
// ---------------------------------------------------------------------------
function waitForDeps() {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000; // 10 s max wait
        function check() {
            const missing = [];
            if (typeof L === 'undefined')    missing.push('Leaflet');
            if (typeof Chart === 'undefined') missing.push('Chart.js');
            if (typeof XLSX === 'undefined')  missing.push('SheetJS');

            if (missing.length === 0) {
                console.log('[RuralExplorer] All dependencies ready');
                resolve();
            } else if (Date.now() > deadline) {
                reject(new Error('Dependencies never loaded: ' + missing.join(', ')));
            } else {
                console.log('[RuralExplorer] Waiting for:', missing.join(', '));
                setTimeout(check, 200);
            }
        }
        check();
    });
}

// ---------------------------------------------------------------------------
// 3. MAP INITIALISATION  (isolated try/catch + retry)
// ---------------------------------------------------------------------------
function initMap() {
    try {
        map = L.map('map', { zoomControl: false, preferCanvas: true })
               .setView([38.8, -77.5], 8);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);

        L.control.zoom({ position: 'bottomright' }).addTo(map);
        markers = L.featureGroup().addTo(map);
        console.log('[RuralExplorer] Map OK');
    } catch (e) {
        console.warn('[RuralExplorer] Map init failed, retry in 600 ms —', e.message);
        setTimeout(() => {
            try {
                map = L.map('map', { zoomControl: false, preferCanvas: true })
                       .setView([38.8, -77.5], 8);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    maxZoom: 19,
                    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                }).addTo(map);
                L.control.zoom({ position: 'bottomright' }).addTo(map);
                markers = L.featureGroup().addTo(map);
                console.log('[RuralExplorer] Map OK (retry)');
            } catch (e2) {
                console.error('[RuralExplorer] Map retry failed —', e2.message);
            }
        }, 600);
    }
}

// ---------------------------------------------------------------------------
// 4. URL EXTRACTION FROM =HYPERLINK() FORMULAS
// ---------------------------------------------------------------------------
function extractURL(cellValue) {
    if (!cellValue || typeof cellValue !== 'string') return '#';
    const match = cellValue.match(/=HYPERLINK\(\s*"([^"]+)"/i);
    if (match && match[1]) return match[1];
    if (cellValue.startsWith('http://') || cellValue.startsWith('https://')) return cellValue;
    return '#';
}

// ---------------------------------------------------------------------------
// 5. MULTI-PATH FETCH  (tries 3 locations)
// ---------------------------------------------------------------------------
async function fetchFromMultiplePaths(fileName) {
    const candidates = [
        `data/list/${fileName}.xlsx`,
        `data/${fileName}.xlsx`,
        `${fileName}.xlsx`
    ];
    for (const path of candidates) {
        console.log('[RuralExplorer] Trying:', path);
        try {
            const res = await fetch(path);
            if (res.ok) {
                console.log('[RuralExplorer] Found at:', path);
                return { response: res, path };
            }
        } catch (e) { /* network error on this path, try next */ }
    }
    throw new Error(
        `"${fileName}.xlsx" not found. Tried: ${candidates.join(', ')}. ` +
        `Make sure the file is in your repo.`
    );
}

// ---------------------------------------------------------------------------
// 6. EXCEL LOADING & PARSING
// ---------------------------------------------------------------------------
async function loadExcelData(fileName) {
    const status    = document.getElementById('statusUpdate');
    const statusLed = document.getElementById('statusLed');
    const pathTrace = document.getElementById('pathTrace');

    // 15 s watchdog
    if (loadTimeout) clearTimeout(loadTimeout);
    loadTimeout = setTimeout(() => {
        statusLed.className = 'w-2.5 h-2.5 rounded-full bg-red-500 border border-white/20';
        status.innerHTML = '<span style="color:#f87171;">TIMEOUT — stalled after 15 s. Check console.</span>';
        pathTrace.innerText = 'Watchdog fired';
    }, 15000);

    try {
        status.innerText    = `ACCESSING ${fileName}...`;
        pathTrace.innerText = 'Searching…';
        statusLed.className = 'w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse border border-white/20';

        const { response, path } = await fetchFromMultiplePaths(fileName);
        pathTrace.innerText = `Loaded: ${path}`;

        const arrayBuffer = await response.arrayBuffer();

        // raw:true keeps =HYPERLINK() formula strings intact
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array', raw: true });
        const sheet    = workbook.Sheets[workbook.SheetNames[0]];
        const rawJson  = XLSX.utils.sheet_to_json(sheet, { raw: true });

        console.log('[RuralExplorer] Rows parsed:', rawJson.length);
        if (rawJson.length > 0) console.log('[RuralExplorer] Columns:', Object.keys(rawJson[0]));

        // Normalise — exact header names from the spreadsheet
        currentData = rawJson.map((row, index) => {
            const price     = parseFloat(row['Price'])             || 0;
            const acres     = parseFloat(row['Acres'])             || 0;
            const lat       = parseFloat(row['Latitude']);
            const lng       = parseFloat(row['Longitude']);
            const driveTime = parseInt(row['Drive Dist (mi)'], 10) || 0;
            const llmScore  = parseInt(row['LLM Score'], 10)       || 0;
            const address   = (row['Address'] || 'Unnamed').toString().trim();
            const city      = (row['City']    || '').toString().trim();
            const state     = (row['State']  || '').toString().trim();
            const type      = (row['Type']   || 'Land').toString().trim();
            const url       = extractURL(row['Property URL Link']);
            const fullAddress = city && state ? `${address}, ${city}, ${state}` : address;

            return { id: index, address: fullAddress, price, acres, llmScore, lat, lng, driveTime, url, type };
        }).filter(p => p.price > 0 && !isNaN(p.lat) && !isNaN(p.lng));

        console.log('[RuralExplorer] Valid properties:', currentData.length);

        clearTimeout(loadTimeout);
        status.innerText    = `LOADED — ${currentData.length} properties`;
        statusLed.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 border border-white/20';

        renderUI();

    } catch (err) {
        clearTimeout(loadTimeout);
        console.error('[RuralExplorer] Load failed:', err);
        status.innerHTML    = `<span style="color:#f87171;">LOAD FAILED: ${err.message}</span>`;
        statusLed.className = 'w-2.5 h-2.5 rounded-full bg-red-500 border border-white/20';
        pathTrace.innerText = 'Error — see console';
    }
}

// ---------------------------------------------------------------------------
// 7. RENDER ORCHESTRATOR
// ---------------------------------------------------------------------------
function renderUI() {
    renderListings();
    renderChart();
    renderAnalysis();

    if (map && markers && markers.getLayers().length > 0) {
        try { map.fitBounds(markers.getBounds().pad(0.15)); }
        catch (e) { console.warn('[RuralExplorer] fitBounds —', e.message); }
    }
}

// ---------------------------------------------------------------------------
// 8. LISTING CARDS + MAP MARKERS
// ---------------------------------------------------------------------------
function renderListings() {
    const grid = document.getElementById('listingGrid');
    grid.innerHTML = '';
    if (markers) markers.clearLayers();

    currentData.forEach(p => {
        const card = document.createElement('div');
        card.className = 'bg-white p-5 rounded-2xl shadow-sm border border-gray-100 hover:border-emerald-500 transition-all cursor-pointer group property-card';
        const ppa = p.acres > 0 ? Math.round(p.price / p.acres).toLocaleString() : '—';

        card.innerHTML = `
            <div class="flex justify-between items-start mb-4">
                <span class="text-[10px] font-black text-emerald-600 bg-emerald-50 px-2 py-1 rounded uppercase tracking-tighter">LLM Score: ${p.llmScore}</span>
                <span class="text-[10px] text-gray-400 font-bold uppercase">${p.type}</span>
            </div>
            <h3 class="text-2xl font-black text-slate-800">$${p.price.toLocaleString()}</h3>
            <p class="text-gray-500 text-xs mb-4 font-medium truncate" title="${p.address}">${p.address}</p>
            <div class="flex gap-4 mb-4">
                <div class="text-xs font-bold text-slate-600">🌲 ${p.acres} ac</div>
                <div class="text-xs font-bold text-slate-600">🚗 ${p.driveTime} mi</div>
                <div class="text-xs font-bold text-slate-500">$${ppa}/ac</div>
            </div>
            <a href="${p.url}" target="_blank" rel="noopener noreferrer"
               class="block w-full py-3 bg-slate-900 text-white text-center text-[10px] font-black rounded-xl group-hover:bg-emerald-600 transition-colors uppercase tracking-widest"
               onclick="event.stopPropagation();"
            >Explore Original Listing</a>`;

        card.addEventListener('click', () => { if (map) map.flyTo([p.lat, p.lng], 13); });
        grid.appendChild(card);

        // Map marker
        if (markers) {
            L.circleMarker([p.lat, p.lng], {
                radius: 9,
                fillColor: p.llmScore >= 90 ? '#10b981' : '#64748b',
                color: '#fff', weight: 2, fillOpacity: 0.9
            })
            .bindPopup(
                `<div style="min-width:140px;">
                    <b style="font-size:14px;">$${p.price.toLocaleString()}</b><br>
                    <span style="font-size:11px;color:#64748b;">${p.address}</span><br>
                    <span style="font-size:10px;color:#64748b;">${p.acres} ac | Score: ${p.llmScore}</span><br>
                    <a href="${p.url}" target="_blank" rel="noopener noreferrer"
                       style="font-size:11px;color:#10b981;font-weight:bold;">View Listing →</a>
                </div>`
            )
            .addTo(markers);
        }
    });

    document.getElementById('listingCount').innerText = `${currentData.length} Strategic Assets`;
}

// ---------------------------------------------------------------------------
// 9. SIDEBAR ANALYSIS
// ---------------------------------------------------------------------------
function renderAnalysis() {
    if (currentData.length === 0) return;

    const avgPrice = currentData.reduce((s, p) => s + p.price, 0) / currentData.length;
    const avgPPA   = currentData.reduce((s, p) => s + (p.acres > 0 ? p.price / p.acres : 0), 0) / currentData.length;

    document.getElementById('avgPrice').innerText = `$${Math.round(avgPrice).toLocaleString()}`;
    document.getElementById('avgAcres').innerText = `$${Math.round(avgPPA).toLocaleString()}/ac`;

    const sorted  = [...currentData].sort((a, b) => b.llmScore - a.llmScore);
    const top     = sorted[0];

    document.getElementById('marketNarrative').innerText =
        `Market signals prioritise "${top.address}" — LLM score ${top.llmScore}, ` +
        `${top.driveTime} mi out. Average density: $${Math.round(avgPPA).toLocaleString()}/acre across ${currentData.length} listings.`;

    const picks = document.getElementById('topPicks');
    picks.innerHTML = '';
    sorted.slice(0, 3).forEach((p, i) => {
        picks.innerHTML += `
            <div class="bg-white p-3 rounded-xl border border-slate-100 flex justify-between items-center shadow-sm">
                <div style="max-width:70%;overflow:hidden;">
                    <p class="text-[9px] font-black text-slate-400 uppercase truncate">${p.address}${i===0?' 🏆':''}</p>
                    <p class="text-xs font-black text-slate-800">$${p.price.toLocaleString()}</p>
                    <p class="text-[9px] text-slate-400">${p.acres} ac · ${p.driveTime} mi</p>
                </div>
                <span class="text-sm font-black text-emerald-500">${p.llmScore}</span>
            </div>`;
    });
}

// ---------------------------------------------------------------------------
// 10. BUBBLE CHART
// ---------------------------------------------------------------------------
function renderChart() {
    const ctx = document.getElementById('marketChart').getContext('2d');
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

    chartInstance = new Chart(ctx, {
        type: 'bubble',
        data: {
            datasets: [{
                label: 'Market Positioning',
                data: currentData.map(p => ({
                    x: p.driveTime,
                    y: p.acres > 0 ? Math.round(p.price / p.acres) : 0,
                    r: Math.max(4, p.llmScore / 8)
                })),
                backgroundColor:      'rgba(16,185,129,0.55)',
                borderColor:          'rgba(16,185,129,0.9)',
                borderWidth:          1,
                hoverBackgroundColor: 'rgba(16,185,129,1)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const p = currentData[ctx.dataIndex];
                            return p ? `${p.address} — $${p.price.toLocaleString()} | ${p.acres} ac` : '';
                        }
                    }
                }
            },
            scales: {
                x: { title: { display:true, text:'Drive Distance (mi)', font:{size:10,weight:'bold'} }, ticks:{font:{size:9}} },
                y: { title: { display:true, text:'$ / Acre',           font:{size:10,weight:'bold'} }, ticks:{font:{size:9}, callback: v => '$'+v.toLocaleString()} }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// 11. BOOTSTRAP  — fires on DOMContentLoaded, NOT window load.
//     Then waits for CDN deps via polling before doing anything.
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async function() {
    const status    = document.getElementById('statusUpdate');
    const statusLed = document.getElementById('statusLed');
    const pathTrace = document.getElementById('pathTrace');

    status.innerText    = 'WAITING FOR LIBS...';
    pathTrace.innerText = 'Polling for dependencies…';

    try {
        await waitForDeps();                // polls until L, Chart, XLSX exist
        status.innerText = 'INITIALIZING...';
        initMap();                          // isolated try/catch inside
        await loadExcelData('Feb012026');   // isolated try/catch inside
    } catch (err) {
        console.error('[RuralExplorer] Bootstrap failed:', err);
        status.innerHTML    = `<span style="color:#f87171;">BOOT FAILED: ${err.message}</span>`;
        statusLed.className = 'w-2.5 h-2.5 rounded-full bg-red-500 border border-white/20';
        pathTrace.innerText = 'See console';
    }
});

// Snapshot selector
document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('fileSelector').addEventListener('change', function(e) {
        loadExcelData(e.target.value);
    });
});
