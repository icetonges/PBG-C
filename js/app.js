/**
 * RURAL EXPLORER — app.js  v2.2
 * ============================================================
 * Architecture : Static client-side decision-support dashboard.
 * Data source  : Excel (.xlsx) parsed with SheetJS (raw mode).
 *
 * BUG FIXES applied in this version:
 *   1. Column mapping — headers are read exactly as they appear
 *      in the spreadsheet ("Price", "Acres", "LLM Score", etc.).
 *      The old fuzzy-alias approach silently returned null for
 *      headers containing spaces or special characters like
 *      "Drive Dist (mi)" and "Property URL Link".
 *
 *   2. URL extraction — the "Property URL Link" column stores
 *      unevaluated Excel HYPERLINK formulas, e.g.:
 *        =HYPERLINK("https://…","View Listing")
 *      SheetJS in default mode evaluates these and returns only
 *      the display text ("View Listing").  We now load the
 *      workbook with { raw: true } so formulas are preserved,
 *      then regex-extract the first quoted URL string.
 *
 *   3. Map tiles — switched from CartoDB (which can block
 *      requests from GitHub Pages origins) to the standard
 *      OpenStreetMap tile server with correct attribution.
 *      Also ensured the map container has an explicit pixel
 *      height set in CSS so Leaflet can initialise its grid.
 * ============================================================
 */

// ---------------------------------------------------------------------------
// 1. GLOBAL STATE
// ---------------------------------------------------------------------------
let currentData   = [];          // Normalised property array
let chartInstance  = null;        // Chart.js bubble chart handle
let map, markers;                // Leaflet map + marker layer

// ---------------------------------------------------------------------------
// 2. MAP INITIALISATION
//    Runs once on page load.  We use OpenStreetMap tiles which are
//    permissively licensed and do not require an API key.
// ---------------------------------------------------------------------------
function initMap() {
    map = L.map('map', {
        zoomControl: false,   // We add zoom at a custom position below
        // Prevent the map from attempting to render before CSS has set the
        // container height (avoids the "Map container is being initialized
        // with a height of 0" warning).
        preferCanvas: true
    }).setView([38.8, -77.5], 8);

    // OpenStreetMap tile layer — works on any origin including GitHub Pages
    L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }
    ).addTo(map);

    // Zoom control moved to bottom-right to avoid overlapping the header
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Feature group gives us .getBounds() for auto-fitting
    markers = L.featureGroup().addTo(map);
}

// ---------------------------------------------------------------------------
// 3. URL EXTRACTION FROM HYPERLINK FORMULAS
//    Excel cells contain strings like:
//      =HYPERLINK("https://www.google.com/search?q=…","View Listing")
//    We extract the URL between the first pair of quotes after HYPERLINK(.
//    If the string is already a plain URL or is missing, we fall back to '#'.
// ---------------------------------------------------------------------------
function extractURL(cellValue) {
    if (!cellValue || typeof cellValue !== 'string') return '#';

    // Case A — raw HYPERLINK formula (what SheetJS gives us with raw:true)
    const match = cellValue.match(/=HYPERLINK\(\s*"([^"]+)"/i);
    if (match && match[1]) return match[1];

    // Case B — already a plain URL
    if (cellValue.startsWith('http://') || cellValue.startsWith('https://')) return cellValue;

    // Case C — unrecognised format; return hash so the link is at least safe
    return '#';
}

// ---------------------------------------------------------------------------
// 4. EXCEL LOADING & PARSING
//    Key detail: we pass { raw: true } to XLSX.read() so that formula cells
//    are NOT evaluated.  This preserves the =HYPERLINK(...) strings that
//    contain our actual URLs.  Without this flag SheetJS returns only the
//    display text ("View Listing") and the URLs are lost.
// ---------------------------------------------------------------------------
async function loadExcelData(fileName) {
    const status    = document.getElementById('statusUpdate');
    const statusLed = document.getElementById('statusLed');
    const pathTrace = document.getElementById('pathTrace');

    // The xlsx lives at the repo root in a "data/list/" folder.
    // Adjust this path if your directory structure differs.
    const fileRelPath = `data/list/${fileName}.xlsx`;

    try {
        // --- Status: loading ---
        status.innerText  = `ACCESSING ${fileName}...`;
        pathTrace.innerText = `Target: ${fileRelPath}`;
        statusLed.className = 'w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse border border-white/20';

        // Fetch the Excel file
        const response = await fetch(fileRelPath);
        if (!response.ok) throw new Error(`HTTP ${response.status} — file not found at "${fileRelPath}"`);

        const arrayBuffer = await response.arrayBuffer();

        // *** CRITICAL: raw:true preserves formula strings ***
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), {
            type:   'array',
            raw:    true   // <— keeps =HYPERLINK() formulas intact
        });

        const sheet  = workbook.Sheets[workbook.SheetNames[0]];

        // sheet_to_json with raw:true returns formula strings as-is
        const rawJson = XLSX.utils.sheet_to_json(sheet, { raw: true });

        console.log('[RuralExplorer] Raw row count:', rawJson.length);
        if (rawJson.length > 0) {
            console.log('[RuralExplorer] Detected columns:', Object.keys(rawJson[0]));
        }

        // --- Normalise rows using EXACT column headers from the spreadsheet ---
        // Headers confirmed via inspection:
        //   Address | City | State | Price | Acres | Type | Score | Notes |
        //   Latitude | Longitude | Drive Dist (mi) | Drive Adv/Disadv |
        //   LLM Score | Property URL Link
        currentData = rawJson.map((row, index) => {
            const price      = parseFloat(row['Price'])             || 0;
            const acres      = parseFloat(row['Acres'])             || 0;
            const lat        = parseFloat(row['Latitude']);
            const lng        = parseFloat(row['Longitude']);
            const driveTime  = parseInt(row['Drive Dist (mi)'],10) || 0;
            const llmScore   = parseInt(row['LLM Score'],10)       || 0;
            const address    = (row['Address'] || 'Unnamed Property').toString().trim();
            const city       = (row['City']    || '').toString().trim();
            const state      = (row['State']  || '').toString().trim();
            const type       = (row['Type']   || 'Land').toString().trim();
            const url        = extractURL(row['Property URL Link']);

            // Build a human-readable full address for cards / popups
            const fullAddress = city && state
                ? `${address}, ${city}, ${state}`
                : address;

            return { id: index, address: fullAddress, price, acres, llmScore, lat, lng, driveTime, url, type };
        }).filter(p => {
            // Keep only rows that have a valid price AND valid coordinates
            const valid = p.price > 0 && !isNaN(p.lat) && !isNaN(p.lng);
            if (!valid) console.warn('[RuralExplorer] Skipping row', p.id, '— invalid price or coords');
            return valid;
        });

        console.log('[RuralExplorer] Usable properties:', currentData.length);
        console.log('[RuralExplorer] Sample URLs:', currentData.slice(0, 3).map(d => d.url));

        // --- Status: success ---
        status.innerText  = `${fileName} LOADED — ${currentData.length} properties`;
        statusLed.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 border border-white/20';

        renderUI();

    } catch (err) {
        console.error('[RuralExplorer] Critical failure:', err);
        status.innerHTML  = `<span style="color:#f87171;">LOAD FAILED: ${err.message}</span>`;
        statusLed.className = 'w-2.5 h-2.5 rounded-full bg-red-500 border border-white/20';
    }
}

// ---------------------------------------------------------------------------
// 5. RENDER ORCHESTRATOR
// ---------------------------------------------------------------------------
function renderUI() {
    renderListings();
    renderChart();
    renderAnalysis();

    // Fit map viewport to all markers (with a little padding)
    if (markers && markers.getLayers().length > 0) {
        map.fitBounds(markers.getBounds().pad(0.15));
    }
}

// ---------------------------------------------------------------------------
// 6. LISTING CARDS + MAP MARKERS
// ---------------------------------------------------------------------------
function renderListings() {
    const grid = document.getElementById('listingGrid');
    grid.innerHTML = '';
    if (markers) markers.clearLayers();

    currentData.forEach(p => {
        // --- Card DOM ---
        const card = document.createElement('div');
        card.className = 'bg-white p-5 rounded-2xl shadow-sm border border-gray-100 hover:border-emerald-500 transition-all cursor-pointer group property-card';

        // Price per acre helper
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
            <!-- Listing link — opens in a new tab. href is set from the extracted URL. -->
            <a href="${p.url}"
               target="_blank"
               rel="noopener noreferrer"
               class="block w-full py-3 bg-slate-900 text-white text-center text-[10px] font-black rounded-xl group-hover:bg-emerald-600 transition-colors uppercase tracking-widest"
               onclick="event.stopPropagation();"
            >Explore Original Listing</a>
        `;

        // Clicking the card (but not the link) flies the map to that pin
        card.addEventListener('click', () => {
            map.flyTo([p.lat, p.lng], 13);
        });

        grid.appendChild(card);

        // --- Map marker ---
        // Green for high-scoring (>= 90), slate for the rest
        const markerColor = p.llmScore >= 90 ? '#10b981' : '#64748b';

        const marker = L.circleMarker([p.lat, p.lng], {
            radius:      9,
            fillColor:   markerColor,
            color:       '#ffffff',
            weight:      2,
            fillOpacity: 0.9
        });

        // Popup includes a clickable link to the listing
        marker.bindPopup(
            `<div style="min-width:140px; font-family:sans-serif;">
                <b style="font-size:14px;">$${p.price.toLocaleString()}</b><br>
                <span style="font-size:11px; color:#64748b;">${p.address}</span><br>
                <span style="font-size:10px; color:#64748b;">${p.acres} ac &nbsp;|&nbsp; Score: ${p.llmScore}</span><br>
                <a href="${p.url}" target="_blank" rel="noopener noreferrer"
                   style="font-size:11px; color:#10b981; font-weight:bold; text-decoration:underline;">
                    View Listing →
                </a>
            </div>`
        );

        if (markers) marker.addTo(markers);
    });

    // Update the heading with the property count
    document.getElementById('listingCount').innerText = `${currentData.length} Strategic Assets`;
}

// ---------------------------------------------------------------------------
// 7. SIDEBAR ANALYSIS
// ---------------------------------------------------------------------------
function renderAnalysis() {
    if (currentData.length === 0) return;

    // Averages
    const totalPrice   = currentData.reduce((sum, p) => sum + p.price, 0);
    const avgPrice     = totalPrice / currentData.length;
    const totalPPA     = currentData.reduce((sum, p) => sum + (p.acres > 0 ? p.price / p.acres : 0), 0);
    const avgPricePerAcre = totalPPA / currentData.length;

    document.getElementById('avgPrice').innerText  = `$${Math.round(avgPrice).toLocaleString()}`;
    document.getElementById('avgAcres').innerText  = `$${Math.round(avgPricePerAcre).toLocaleString()}/ac`;

    // Narrative — driven by the top-scoring property
    const sorted  = [...currentData].sort((a, b) => b.llmScore - a.llmScore);
    const topPick = sorted[0];

    document.getElementById('marketNarrative').innerText =
        `Market signals prioritise "${topPick.address}" as the optimal balance of LLM score ` +
        `(${topPick.llmScore}) vs drive distance (${topPick.driveTime} mi). ` +
        `Average density across this snapshot is $${Math.round(avgPricePerAcre).toLocaleString()}/acre ` +
        `over ${currentData.length} active listings.`;

    // Top 3 picks list
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
// 8. BUBBLE CHART
//    X = drive distance (mi), Y = $/acre, Bubble radius ∝ LLM score
// ---------------------------------------------------------------------------
function renderChart() {
    const ctx = document.getElementById('marketChart').getContext('2d');

    // Destroy any previous instance to prevent memory leaks / flicker
    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }

    chartInstance = new Chart(ctx, {
        type: 'bubble',
        data: {
            datasets: [{
                label: 'Market Positioning',
                data: currentData.map(p => ({
                    x: p.driveTime,
                    y: p.acres > 0 ? Math.round(p.price / p.acres) : 0,
                    r: Math.max(4, p.llmScore / 8)   // scale bubble size; floor at 4px
                })),
                backgroundColor:      'rgba(16, 185, 129, 0.55)',
                borderColor:          'rgba(16, 185, 129, 0.9)',
                borderWidth:          1,
                hoverBackgroundColor: 'rgba(16, 185, 129, 1)'
            }]
        },
        options: {
            responsive:        true,
            maintainAspectRatio: false,
            animation:         { duration: 400 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const idx  = context.dataIndex;
                            const prop = currentData[idx];
                            return prop
                                ? `${prop.address} — $${prop.price.toLocaleString()} | ${prop.acres} ac`
                                : '';
                        }
                    }
                }
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text:    'Drive Distance (mi)',
                        font:    { size: 10, weight: 'bold' }
                    },
                    ticks: { font: { size: 9 } }
                },
                y: {
                    title: {
                        display: true,
                        text:    '$ / Acre',
                        font:    { size: 10, weight: 'bold' }
                    },
                    ticks: {
                        font: { size: 9 },
                        callback: function(value) {
                            return '$' + value.toLocaleString();
                        }
                    }
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// 9. EVENT WIRING
// ---------------------------------------------------------------------------

// Snapshot selector triggers a fresh data load
document.getElementById('fileSelector').addEventListener('change', function(e) {
    loadExcelData(e.target.value);
});

// Bootstrap on page load — initialise the map first, then load data
window.addEventListener('load', function() {
    initMap();
    loadExcelData('Feb012026');
});
