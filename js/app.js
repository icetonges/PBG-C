/**
 * RURAL EXPLORER - COMPREHENSIVE ENGINE v2.1
 * Architecture: Static Decision Support System
 */

let currentData = [];
let chartInstance = null;
let map = L.map('map', { zoomControl: false }).setView([38.8, -77.5], 8);
let markers = L.featureGroup().addTo(map); // FIXED: Use featureGroup for getBounds()

L.tileLayer('https://{s}.tile.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map);
L.control.zoom({ position: 'bottomright' }).addTo(map);

// FUZZY DATA MAPPER: Prevents "undefined" by searching for common header names
const findCol = (row, aliases) => {
    const keys = Object.keys(row);
    for (let alias of aliases) {
        const found = keys.find(k => k.toLowerCase().replace(/\s/g, '') === alias.toLowerCase());
        if (found) return row[found];
    }
    return null;
};

async function loadExcelData(fileName) {
    const status = document.getElementById('statusUpdate');
    const statusLed = document.getElementById('statusLed');
    const pathTrace = document.getElementById('pathTrace');
    const fileRelPath = `data/list/${fileName}.xlsx`;

    try {
        status.innerText = `ACCESSING ${fileName}...`;
        pathTrace.innerText = `Target: ${new URL(fileRelPath, window.location.href).pathname}`;
        statusLed.className = "w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse";

        const response = await fetch(fileRelPath);
        if (!response.ok) throw new Error(`HTTP ${response.status}: File Not Found`);
        
        const arrayBuffer = await response.arrayBuffer();
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rawJson = XLSX.utils.sheet_to_json(sheet);

        // Normalize data with fallbacks
        currentData = rawJson.map((row, index) => ({
            id: index,
            address: findCol(row, ['address', 'location', 'addr', 'name']) || 'Unnamed Property',
            price: parseFloat(findCol(row, ['price', 'cost', 'amount'])) || 0,
            acres: parseFloat(findCol(row, ['acres', 'acreage', 'landsize'])) || 0,
            score: parseInt(findCol(row, ['score', 'rating', 'llm_score'])) || 0,
            lat: parseFloat(findCol(row, ['lat', 'latitude'])),
            lng: parseFloat(findCol(row, ['lng', 'longitude', 'long'])),
            driveTime: parseInt(findCol(row, ['drivetime', 'minutes', 'distance'])) || 0,
            url: findCol(row, ['url', 'link', 'listing']) || '#',
            type: findCol(row, ['type', 'category']) || 'Land'
        })).filter(p => p.price > 0 && !isNaN(p.lat));

        status.innerText = `${fileName} LOADED`;
        statusLed.className = "w-2.5 h-2.5 rounded-full bg-emerald-500 border border-white/20";
        renderUI();

    } catch (err) {
        console.error("Critical Failure:", err);
        status.innerHTML = `<span class="text-red-400">LOAD FAILED: ${err.message}</span>`;
        statusLed.className = "w-2.5 h-2.5 rounded-full bg-red-500 border border-white/20";
    }
}

function renderUI() {
    renderListings();
    renderChart();
    renderAnalysis();
    
    if (markers.getLayers().length > 0) {
        map.fitBounds(markers.getBounds().pad(0.1));
    }
}

function renderListings() {
    const grid = document.getElementById('listingGrid');
    grid.innerHTML = '';
    markers.clearLayers();

    currentData.forEach(p => {
        const card = document.createElement('div');
        card.className = 'bg-white p-5 rounded-2xl shadow-sm border border-gray-100 hover:border-emerald-500 transition-all cursor-pointer group';
        card.innerHTML = `
            <div class="flex justify-between items-start mb-4">
                <span class="text-[10px] font-black text-emerald-600 bg-emerald-50 px-2 py-1 rounded uppercase tracking-tighter">LLM SCORE: ${p.score}</span>
                <span class="text-[10px] text-gray-400 font-bold uppercase">${p.type}</span>
            </div>
            <h3 class="text-2xl font-black text-slate-800">$${p.price.toLocaleString()}</h3>
            <p class="text-gray-500 text-xs mb-4 font-medium truncate">${p.address}</p>
            <div class="flex gap-4 mb-4">
                <div class="flex items-center gap-1 text-xs font-bold text-slate-600">🌲 ${p.acres} ac</div>
                <div class="flex items-center gap-1 text-xs font-bold text-slate-600">🚗 ${p.driveTime}m</div>
            </div>
            <a href="${p.url}" target="_blank" class="block w-full py-3 bg-slate-900 text-white text-center text-[10px] font-black rounded-xl group-hover:bg-emerald-600 transition-colors uppercase tracking-widest">Explore Original Listing</a>
        `;
        card.onclick = () => map.flyTo([p.lat, p.lng], 13);
        grid.appendChild(card);

        L.circleMarker([p.lat, p.lng], {
            radius: 10,
            fillColor: p.score > 85 ? "#10b981" : "#64748b",
            color: "#fff", weight: 2, fillOpacity: 0.9
        }).addTo(markers).bindPopup(`<b>$${p.price.toLocaleString()}</b><br>${p.address}`);
    });

    document.getElementById('listingCount').innerText = `${currentData.length} Strategic Assets`;
}

function renderAnalysis() {
    const avgPrice = currentData.reduce((a,b) => a + b.price, 0) / currentData.length;
    const avgAcreVal = currentData.reduce((a,b) => a + (b.price/b.acres), 0) / currentData.length;
    
    document.getElementById('avgPrice').innerText = `$${Math.round(avgPrice).toLocaleString()}`;
    document.getElementById('avgAcres').innerText = `$${Math.round(avgAcreVal).toLocaleString()}/ac`;

    // Strategy Insight
    const sorted = [...currentData].sort((a,b) => b.score - a.score);
    const topPick = sorted[0];
    document.getElementById('marketNarrative').innerText = 
        `Market signals prioritize ${topPick.address} as the optimal balance of score (${topPick.score}) vs distance. Average density is ${Math.round(avgAcreVal)}/acre across this snapshot.`;

    // Render Top Picks Sidebar
    const picksContainer = document.getElementById('topPicks');
    picksContainer.innerHTML = '';
    sorted.slice(0, 3).forEach(pick => {
        picksContainer.innerHTML += `
            <div class="bg-white p-3 rounded-xl border border-slate-100 flex justify-between items-center shadow-sm">
                <div>
                    <p class="text-[9px] font-black text-slate-400 uppercase">${pick.address}</p>
                    <p class="text-xs font-black text-slate-800">$${pick.price.toLocaleString()}</p>
                </div>
                <span class="text-xs font-black text-emerald-500">${pick.score}</span>
            </div>
        `;
    });
}

function renderChart() {
    const ctx = document.getElementById('marketChart').getContext('2d');
    if (chartInstance) chartInstance.destroy(); // FIXED: Prevents infinite looping/flicker

    chartInstance = new Chart(ctx, {
        type: 'bubble',
        data: {
            datasets: [{
                label: 'Market Positioning',
                data: currentData.map(p => ({
                    x: p.driveTime,
                    y: p.price / p.acres,
                    r: p.score / 5
                })),
                backgroundColor: 'rgba(16, 185, 129, 0.6)',
                hoverBackgroundColor: 'rgba(16, 185, 129, 1)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 }, // FIXED: Stop animation loops
            plugins: { legend: { display: false } },
            scales: {
                x: { title: { display: true, text: 'Mins from Fairfax', font: { size: 9, weight: 'bold' } } },
                y: { title: { display: true, text: '$/Acre', font: { size: 9, weight: 'bold' } } }
            }
        }
    });
}

document.getElementById('fileSelector').addEventListener('change', e => loadExcelData(e.target.value));
window.onload = () => loadExcelData('Feb012026');