/**
 * RURAL EXPLORER — app.js  v2.3
 * ============================================================
 * v2.3 fixes (why the page was stuck on "INITIALIZING SYSTEM…"):
 *   A. initMap() was NOT wrapped in try/catch.  If Leaflet threw
 *      (container height 0, script load race, etc.) the entire
 *      window.load handler died — loadExcelData() never ran and
 *      the status LED stayed yellow forever.  Now isolated with
 *      a 500 ms retry so a transient CSS-timing issue self-heals.
 *
 *   B. fetch() used a single hardcoded path ("data/list/…").
 *      If the xlsx was placed anywhere else in the repo, the
 *      request 404'd silently and the catch block never fired
 *      visibly.  Now tries three common paths in sequence:
 *        1. data/list/Feb012026.xlsx
 *        2. data/Feb012026.xlsx
 *        3. Feb012026.xlsx   (repo root)
 *
 *   C. No timeout existed.  A network hang or silent CORS block
 *      on GitHub Pages left the yellow LED spinning forever.
 *      A 15 s watchdog now flips the LED red with a clear message.
 *
 * Previous fixes (v2.2) retained:
 *   1. Column headers matched exactly to the spreadsheet.
 *   2. =HYPERLINK() formula strings parsed for real URLs.
 *   3. OpenStreetMap tiles instead of CartoDB.
 * ============================================================
 */

// ---------------------------------------------------------------------------
// 1. GLOBAL STATE
// ---------------------------------------------------------------------------
let currentData   = [];
let chartInstance  = null;
let map            = null;
let markers        = null;
let loadTimeout    = null;   // watchdog timer handle

// ---------------------------------------------------------------------------
// 2. MAP INITIALISATION  (isolated — cannot crash the data load)
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

        console.log('[RuralExplorer] Map initialised OK');
    } catch (e) {
        // Most common cause: container height is still 0 when Leaflet runs.
        // Retry after 500 ms — by then CSS will have applied.
        console.warn('[RuralExplorer] Map init failed, retrying in 500 ms —', e.message);
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
                console.log('[RuralExplorer] Map initialised on retry');
            } catch (e2) {
                console.error('[RuralExplorer] Map retry also failed —', e2.message);
            }
        }, 500);
    }
}

// ---------------------------------------------------------------------------
// 3. URL EXTRACTION FROM HYPERLINK FORMULAS
// ---------------------------------------------------------------------------
function extractURL(cellValue) {
    if (!cellValue || typeof cellValue !== 'string') return '#';

    // =HYPERLINK("https://…","View Listing")  →  extract the URL
    const match = cellValue.match(/=HYPERLINK\(\s*"([^"]+)"/i);
    if (match && match[1]) return match[1];

    // Already a plain URL
    if (cellValue.startsWith('http://') || cellValue.startsWith('https://')) return cellValue;

    return '#';
}

// ---------------------------------------------------------------------------
// 4. MULTI-PATH FETCH HELPER
//    Tries several candidate paths and returns the first successful Response.
//    This way the app works whether the xlsx is in data/list/, data/, or root.
// ---------------------------------------------------------------------------
async function fetchFromMultiplePaths(fileName) {
    const candidates = [
        `data/list/${fileName}.xlsx`,   // original expected path
        `data/${fileName}.xlsx`,        // flat data folder
        `${fileName}.xlsx`              // repo root
    ];

    for (const path of candidates) {
        console.log('[RuralExplorer] Trying path:', path);
        try {
            const res = await fetch(path);
            if (res.ok) {
                console.log('[RuralExplorer] Found file at:', path);
                return { response: res, path: path };
            }
            console.log('[RuralExplorer] Not found at', path, '— status', res.status);
        } catch (networkErr) {
            console.log('[RuralExplorer] Fetch error at', path, '—', networkErr.message);
        }
    }

    // None worked
    throw new Error(
        `Excel file "${fileName}.xlsx" not found. Tried: ${candidates.join(', ')}. ` +
        `Ensure the file is committed to your GitHub Pages repo at one of those paths.`
    );
}

// ---------------------------------------------------------------------------
// 5. EXCEL LOADING & PARSING
// ---------------------------------------------------------------------------
async function loadExcelData(fileName) {
    const status    = document.getElementById('statusUpdate');
    const statusLed = document.getElementById('statusLed');
    const pathTrace = document.getElementById('pathTrace');

    // --- Start the 15-second watchdog. If we haven't finished by then,
    //     flip the LED red so the user knows something is wrong. ---
    if (loadTimeout) clearTimeout(loadTimeout);
    loadTimeout = setTimeout(() => {
        statusLed.className = 'w-2.5 h-2.5 rounded-full bg-red-500 border border-white/20';
        status.innerHTML = '<span style="color:#f87171;">TIMEOUT — loading stalled. Check browser console for details.</span>';
        pathTrace.innerText = 'Watchdog triggered after 15 s';
    }, 15000);

    try {
        // --- Status: loading ---
        status.innerText    = `ACCESSING ${fileName}...`;
        pathTrace.innerText = 'Searching…';
        statusLed.className = 'w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse border border-white/20';

        // --- Find and fetch the file (multi-path) ---
        const { response, path } = await fetchFromMultiplePaths(fileName);
        pathTrace.innerText = `Loaded: ${path}`;

        const arrayBuffer = await response.arrayBuffer();

        // *** raw:true keeps =HYPERLINK() formulas intact ***
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array', raw: true });
        const sheet    = workbook.Sheets[workbook.SheetNames[0]];
        const rawJson  = XLSX.utils.sheet_to_json(sheet, { raw: true });

        console.log('[RuralExplorer] Raw rows:', rawJson.length);
        if (rawJson.length > 0) {
            console.log('[RuralExplorer] Columns:', Object.keys(rawJson[0]));
        }

        // --- Normalise using exact column headers from the spreadsheet ---
        currentData = rawJson.map((row, index) => {
            const price     = parseFloat(row['Price'])            || 0;
            const acres     = parseFloat(row['Acres'])            || 0;
            const lat       = parseFloat(row['Latitude']);
            const lng       = parseFloat(row['Longitude']);
            const driveTime = parseInt(row['Drive Dist (mi)'], 10) || 0;
            const llmScore  = parseInt(row['LLM Score'], 10)      || 0;
            const address   = (row['Address'] || 'Unnamed Property').toString().trim();
            const city      = (row['City']    || '').toString().trim();
            const state     = (row['State']  || '').toString().trim();
            const type      = (row['Type']   || 'Land').toString().trim();
            const url       = extractURL(row['Property URL Link']);

            const fullAddress = city && state ? `${address}, ${city}, ${state}` : address;

            return { id: index, address: fullAddress, price, acres, llmScore, lat, lng, driveTime, url, type };
        }).filter(p => {
            const valid = p.price > 0 && !isNaN(p.lat) && !isNaN(p.lng);
            if (!valid) console.warn('[RuralExplorer] Skipping row', p.id);
            return valid;
        });

        console.log('[RuralExplorer] Usable properties:', currentData.length);
        console.log('[RuralExplorer] Sample URLs:', currentData.slice(0, 3).map(d => d.url));

        // --- Cancel the watchdog — we finished in time ---
        clearTimeout(loadTimeout);

        // --- Status: success ---
        status.innerText    = `${fileName} LOADED — ${currentData.length} properties`;
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
// 6. RENDER ORCHESTRATOR
// ---------------------------------------------------------------------------
function renderUI() {
    renderListings();
    renderChart();
    renderAnalysis();

    // Fit map to markers only if the map is live and has data
    if (map && markers && markers.getLayers().length > 0) {
        try {
            map.fitBounds(markers.getBounds().pad(0.15));
        } catch (e) {
            console.warn('[RuralExplorer] fitBounds failed —', e.message);
        }
    }
}

// ---------------------------------------------------------------------------
// 7. LISTING CARDS + MAP MARKERS
// ---------------------------------------------------------------------------
function renderListings() {
    const grid = document.getElementById('listingGrid');
    grid.innerHTML = '';
    if (markers) markers.clearLayers();

    currentData.forEach(p => {
        const card = document.createElement('div');
        card.className = 'bg-white p-5 rounded-2xl shadow-sm border border-gray-100 hover:border-emerald-500 transition-all cursor-pointer group property-card';

        const pricePerAcre = p.acres > 0 ? Math.round(p.price / p.acres).toLocaleString() : '—';

        card.innerHTML = `
            <div class="flex justify-between items-start mb-4">
                <span class="text-[10px] font-black text-emerald-600 bg-emerald-50 px-2 py-1 rounded uppercase tracking-tighter">LLM Score: ${p.llmScore}</span>
                <span class="text-[10px] text-gray-400 font-bold uppercase">${p.type}</span>
            </div>
            <h3 class="text-2xl font-black text-slate-800">$${p.price.toLocaleString()}</h3>
            <p class="text-gray-500 text-xs mb-4 font-medium truncate" title="${p.address}">${p.address}</p>
            <div class="flex gap-4 mb-4">
                <div class="flex items-center gap-1 text-xs font-bold text-slate-600">🌲 ${p.acres} ac</div>
                <div class="flex items-center gap-1 text-xs font-bold text-slate-600">🚗 ${p.driveTime} mi</div>
                <div class="flex items-center gap-1 text-xs font-bold text-slate-500">$${pricePerAcre}/ac</div>
            </div>
            <a href="${p.url}"
               target="_blank"
               rel="noopener noreferrer"
               class="block w-full py-3 bg-slate-900 text-white text-center text-[10px] font-black rounded-xl group-hover:bg-emerald-600 transition-colors uppercase tracking-widest"
               onclick="event.stopPropagation();"
            >Explore Original Listing</a>
        `;

        // Card click flies the map to that property (link click is isolated via stopPropagation)
        card.addEventListener('click', () => {
            if (map) map.flyTo([p.lat, p.lng], 13);
        });

        grid.appendChild(card);

        // --- Map marker (only if map is initialised) ---
        if (markers) {
            const markerColor = p.llmScore >= 90 ? '#10b981' : '#64748b';

            L.circleMarker([p.lat, p.lng], {
                radius: 9, fillColor: markerColor,
                color: '#ffffff', weight: 2, fillOpacity: 0.9
            })
            .bindPopup(
                `<div style="min-width:140px; font-family:sans-serif;">
                    <b style="font-size:14px;">$${p.price.toLocaleString()}</b><br>
                    <span style="font-size:11px; color:#64748b;">${p.address}</span><br>
                    <span style="font-size:10px; color:#64748b;">${p.acres} ac &nbsp;|&nbsp; Score: ${p.llmScore}</span><br>
                    <a href="${p.url}" target="_blank" rel="noopener noreferrer"
                       style="font-size:11px; color:#10b981; font-weight:bold; text-decoration:underline;">
                        View Listing →
                    </a>
                </div>`
            )
            .addTo(markers);
        }
    });

    document.getElementById('listingCount').innerText = `${currentData.length} Strategic Assets`;
}

// ---------------------------------------------------------------------------
// 8. SIDEBAR ANALYSIS
// ---------------------------------------------------------------------------
function renderAnalysis() {
    if (currentData.length === 0) return;

    const avgPrice        = currentData.reduce((s, p) => s + p.price, 0) / currentData.length;
    const avgPricePerAcre = currentData.reduce((s, p) => s + (p.acres > 0 ? p.price / p.acres : 0), 0) / currentData.length;

    document.getElementById('avgPrice').innerText = `$${Math.round(avgPrice).toLocaleString()}`;
    document.getElementById('avgAcres').innerText = `$${Math.round(avgPricePerAcre).toLocaleString()}/ac`;

    const sorted  = [...currentData].sort((a, b) => b.llmScore - a.llmScore);
    const topPick = sorted[0];

    document.getElementById('marketNarrative').innerText =
        `Market signals prioritise "${topPick.address}" as the optimal balance of LLM score ` +
        `(${topPick.llmScore}) vs drive distance (${topPick.driveTime} mi). ` +
        `Average density across this snapshot is $${Math.round(avgPricePerAcre).toLocaleString()}/acre ` +
        `over ${currentData.length} active listings.`;

    const picksContainer = document.getElementById('topPicks');
    picksContainer.innerHTML = '';

    sorted.slice(0, 3).forEach((pick, idx) => {
        const badge = idx === 0 ? ' 🏆' : '';
        picksContainer.innerHTML += `
            <div class="bg-white p-3 rounded-xl border border-slate-100 flex justify-between items-center shadow-sm">
                <div style="max-width:70%; overflow:hidden;">
                    <p class="text-[9px] font-black text-slate-400 uppercase truncate">${pick.address}${badge}</p>
                    <p class="text-xs font-black text-slate-800">$${pick.price.toLocaleString()}</p>
                    <p class="text-[9px] text-slate-400">${pick.acres} ac &nbsp;·&nbsp; ${pick.driveTime} mi</p>
                </div>
                <span class="text-sm font-black text-emerald-500">${pick.llmScore}</span>
            </div>
        `;
    });
}

// ---------------------------------------------------------------------------
// 9. BUBBLE CHART
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
                backgroundColor:      'rgba(16, 185, 129, 0.55)',
                borderColor:          'rgba(16, 185, 129, 0.9)',
                borderWidth:          1,
                hoverBackgroundColor: 'rgba(16, 185, 129, 1)'
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
                        label: function(context) {
                            const prop = currentData[context.dataIndex];
                            return prop ? `${prop.address} — $${prop.price.toLocaleString()} | ${prop.acres} ac` : '';
                        }
                    }
                }
            },
            scales: {
                x: {
                    title: { display: true, text: 'Drive Distance (mi)', font: { size: 10, weight: 'bold' } },
                    ticks: { font: { size: 9 } }
                },
                y: {
                    title: { display: true, text: '$ / Acre', font: { size: 10, weight: 'bold' } },
                    ticks: {
                        font: { size: 9 },
                        callback: v => '$' + v.toLocaleString()
                    }
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// 10. EVENT WIRING & BOOTSTRAP
// ---------------------------------------------------------------------------
document.getElementById('fileSelector').addEventListener('change', function(e) {
    loadExcelData(e.target.value);
});

// Bootstrap: map and data load are independent.
// If initMap() throws, loadExcelData() still runs (and vice versa).
window.addEventListener('load', function() {
    initMap();                      // isolated in its own try/catch
    loadExcelData('Feb012026');     // has its own try/catch + watchdog
});
