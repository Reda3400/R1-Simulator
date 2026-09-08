<script setup>
// R1-powered dispatcher: ALL intelligence (route/corridor/match/heatmap)
// comes from the R1 core via the local bridge. The app owns state, clock,
// tariff, movement animation and rendering (R1 Leaflet adapter).
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import L from 'leaflet';
import { cellToLatLng } from 'h3-js';
import { Chart, registerables } from 'chart.js';
import { R1Map } from './r1map.js';
import { orderColor, driverIcon as mkDriverIcon, pickupIcon as mkPickupIcon, dropIcon, orderPopup as mkOrderPopup } from './mapMarkers.js';
import {
  R1, R1_BASE, R1_PROVIDER, setProvider, probeOsrm, HEAT_SEC, MAX_WAIT_SEC, resetIds, now, fmtAge,
  haversineM, bearingDeg, remainingOnRoute, inCorridorCells, baseGridCells,
  pricing, setPricing, CITIES, activeCity, setCity,
  makeDriver, makeOrderShell, makeRandomOrderShell, priceOrder,
  driverPayload, orderPayload, stopsSig, randInBBox, randPOIBiased,
  h3CellOf, h3Ring, H3_RES,
} from './r1client.js';
import { defaultCities, createCity, setArea, operatingAreaArg, areaCells, serviceEnabled } from './cityConfig.js';
import { makeEditor, loadEditor, saveEditor, editorHasArea, toggleCell, removeLastCell, clearCells, addVertex, closePolygon, removeLastVertex, clearVerts, refreshAutoFill, ringsOfEditor, applyAreaCells } from './h3Area.js';
import { generateOrders, SERVICE_CAPS, GENERATOR_DEFAULTS, pointInCell } from './orderGenerator.js';

Chart.register(...registerables);
Chart.defaults.color = '#aaa';
Chart.defaults.borderColor = 'rgba(255,255,255,0.12)';
Chart.defaults.font.family = "'JetBrains Mono', monospace";

const mapEl = ref(null);
let map = null, r1map = null;
const layers = { drivers: new Map(), orders: new Map() }; // raw L markers (smooth drag)
const r1ok = ref(false);
// R1 provider: real OSRM roads are ALWAYS on (public demo, zero setup).
// If the demo is unreachable, the app silently uses the offline map and
// retries in the background — the sim always "just works".
const useOsrm = ref(true);
async function checkRoads(quiet = false) {
  const base = R1_PROVIDER.osrmBaseUrl;
  const wasUp = useOsrm.value;
  try {
    if (await probeOsrm(base)) {
      setProvider({ routing: 'osrm', osrmBaseUrl: base });
      useOsrm.value = true;
      return true;
    }
  } finally { /* keep silent; roads are on by contract */ }
  setProvider({ routing: 'mock' });
  useOsrm.value = false;
  if (wasUp && !quiet) pushFeed('OSRM slow right now — offline map, retrying in background', 'warn');
  return false;
}

// ---------- bridge watchdog ----------
// The engine runs in-process (Vite plugin); the only failure left is a
// missing native binding. Pause matching, show ONE banner, retry quietly.
const bridgeDown = ref(false);
let bridgeFails = 0;
function noteBridgeError(e) {
  if (!e || !/^(BRIDGE|R1_)/.test(String(e.code || ''))) return false;
  if (++bridgeFails === 2) {
    bridgeDown.value = true;
    pushFeed('R1 engine unavailable — run: npm run r1:build, then reload. Map keeps moving, matching paused.', 'warn');
  }
  return true;
}
function noteBridgeOk() {
  bridgeFails = 0;
  if (bridgeDown.value) { bridgeDown.value = false; pushFeed('R1 bridge back — matching resumed', 'ok'); }
}

const running = ref(false);
const speed = ref(1); // 1× = REAL time (the sim clock advances with the wall clock)
const tickCount = ref(0);
const showAllCorridors = ref(true);
const showHeat = ref(true);
const liveTraffic = ref(true);
const selectedId = ref(null);
const selectedOrderId = ref(null);
const taxiType = ref('petit');
const follow = ref(true);
const feed = ref([]);
const drivers = reactive([]);
const orders = reactive([]);
let genCounter = 0; // unique generated-order ids across batches (G001, G002, ...)

const simClock = ref(0);
const testCfg = reactive({ active: false, city: 'Casablanca', endAt: 0 });
const testForm = reactive({
  city: 'Casablanca', duration: '3600', petit: 6, grand: 2,
  rate: 2.4, base: 8, mode: 'shared', night: false, bags: false, bagsFee: 5, live: true, priority: false,
  speed: 5,
});
const showSetup = ref(false);
const showResults = ref(false);
const results = ref(null);
const revCanvas = ref(null);
const statusCanvas = ref(null);
const seriesCanvas = ref(null);
let charts = [];
let runSeries = []; // cumulative test stats sampled over each sim-minute
let inFlight = false, heatFlight = false;

// ---------- city configuration + order simulation ----------
// ZERO seeded defaults: the app boots into the SETUP wizard which asks for the
// city name, then the zone, then the fleet. `active` is null until then.
const cities = ref([]);
const activeCityId = ref(null);
const active = computed(() => cities.value.find((c) => c.city_id === activeCityId.value) || null);
const zoneCells = computed(() => (active.value ? areaCells(active.value, 'petit_taxi') : []));
const showCityConfig = ref(false);
const editing = ref(false);      // H3 operating-area editor mode (map click selects cells)
const editor = ref(null);        // transient working cell set (committed only on SAVE)
const newCityName = ref('');
const wizard = reactive({ open: true, step: 'name', name: '', fleetType: 'petit', fleetCount: 4 });
const genForm = reactive({
  service: 'petit_taxi',
  count: 5,
  minPax: 1, maxPax: 3, minBags: 0, maxBags: 2,
  prioNormal: 70, prioHigh: 20, prioUrgent: 8, prioEmergency: 2,
  privateProb: 10,
});
const activeAreaInfo = computed(() => {
  const c = active.value;
  if (!c) return { petitCells: 0, petitOn: false, grandOn: false, summary: '' };
  const petitCells = areaCells(c, 'petit_taxi').length;
  const petitOn = serviceEnabled(c, 'petit_taxi');
  const grandOn = serviceEnabled(c, 'grand_taxi');
  return {
    petitCells, petitOn, grandOn,
    summary: `${c.city_name} · PETIT ${petitOn ? (petitCells ? `${petitCells} H3 cells` : 'NO AREA') : 'OFF'} · GRAND ${grandOn ? 'ON' : 'OFF'}`,
  };
});

/// A sample point INSIDE the petit operating zone (random cell, random pixel).
/// Petit taxis + petit orders are confined to the zone; no zone → whole city.
function confinedPoint() {
  const cells = zoneCells.value;
  if (!cells.length) return randInBBox();
  return pointInCell(cells[Math.floor(Math.random() * cells.length)]);
}

function zoneCentroid(c) {
  const cells = areaCells(c, 'petit_taxi');
  if (!cells.length) return c.center || [33.589, -7.62];
  let lat = 0, lng = 0;
  for (const cell of cells) { const p = cellToLatLng(cell); lat += p[0]; lng += p[1]; }
  return [lat / cells.length, lng / cells.length];
}

function zoneBounds(c) {
  const cells = areaCells(c, 'petit_taxi');
  if (!cells.length) return c.bbox || { minLat: 33.565, maxLat: 33.61, minLng: -7.68, maxLng: -7.58 };
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const cell of cells) {
    const p = cellToLatLng(cell);
    if (p[0] < minLat) minLat = p[0];
    if (p[0] > maxLat) maxLat = p[0];
    if (p[1] < minLng) minLng = p[1];
    if (p[1] > maxLng) maxLng = p[1];
  }
  const pad = 0.002;
  return { minLat: minLat - pad, maxLat: maxLat + pad, minLng: minLng - pad, maxLng: maxLng + pad };
}

function buildCharts() {
  charts.forEach((c) => c.destroy()); charts = [];
  if (!results.value) return;
  const r = results.value;
  if (revCanvas.value && r.rides.length) {
    charts.push(new Chart(revCanvas.value, {
      type: 'bar',
      data: {
        labels: r.rides.map((x) => x.id),
        datasets: [{ label: 'MAD', data: r.rides.map((x) => x.lockedFare ?? x.fare), backgroundColor: '#22c55e', hoverBackgroundColor: '#4ade80', borderRadius: 3 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          title: { display: true, text: 'REVENUE PER RIDE (MAD)', color: '#fff', font: { size: 11 } },
          tooltip: { callbacks: { afterBody: (items) => {
            const o = r.rides[items[0].dataIndex];
            return [`${o.directKm} km · waited ${fmtAge(o.waitSec || 0)}`, `${o.pickupLabel} → ${o.dropoffLabel}`];
          } } },
        },
        scales: { y: { beginAtZero: true }, x: { ticks: { autoSkip: true, maxTicksLimit: 20 } } },
      },
    }));
  }
  if (statusCanvas.value) {
    charts.push(new Chart(statusCanvas.value, {
      type: 'doughnut',
      data: { labels: ['Completed', 'Canceled', 'Still active'], datasets: [{ data: [r.completed, r.canceled, r.active], backgroundColor: ['#22c55e', '#ef4444', '#555'], borderColor: '#000', borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } }, title: { display: true, text: 'RIDE OUTCOMES', color: '#fff', font: { size: 11 } } } },
    }));
  }
  // TIME SERIES from runSeries: the test's cumulative pulse, sampled every sim-minute.
  if (seriesCanvas.value && (r.series || []).length > 1) {
    const s = r.series;
    charts.push(new Chart(seriesCanvas.value, {
      type: 'line',
      data: {
        labels: s.map((p) => `${Math.floor(p.t / 60)}m`),
        datasets: [
          { label: 'CREATED', data: s.map((p) => p.created), borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.12)', tension: 0.3, pointRadius: 0, borderWidth: 2, yAxisID: 'y' },
          { label: 'ACCEPTED', data: s.map((p) => p.accepted), borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.08)', tension: 0.3, pointRadius: 0, borderWidth: 2, yAxisID: 'y' },
          { label: 'WAITING', data: s.map((p) => p.waiting), borderColor: '#facc15', backgroundColor: 'rgba(250,204,21,0.10)', tension: 0.3, pointRadius: 0, borderWidth: 1.5, yAxisID: 'y' },
          { label: 'REJECTED', data: s.map((p) => p.rejected), borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.08)', tension: 0.3, pointRadius: 0, borderWidth: 1.5, yAxisID: 'y', borderDash: [4, 3] },
          { label: 'REVENUE', data: s.map((p) => p.revenue), borderColor: '#c084fc', backgroundColor: 'rgba(192,132,252,0.05)', tension: 0.3, pointRadius: 0, borderWidth: 2, yAxisID: 'y2' },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } },
          title: { display: true, text: 'RUN SERIES — created / accepted / waiting / rejected / revenue (per sim-minute)', color: '#fff', font: { size: 11 } },
          tooltip: { callbacks: { afterBody: (items) => { const p = s[items[0].dataIndex]; return [`${fmtAge(p.t)} · revenue ${p.revenue} MAD`]; } } },
        },
        scales: {
          y: { beginAtZero: true, position: 'left', grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#888', font: { size: 9 } } },
          y2: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#c084fc', font: { size: 9 } } },
          x: { ticks: { autoSkip: true, maxTicksLimit: 15, color: '#888', font: { size: 9 } } },
        },
      },
    }));
  }
}
watch(showResults, async (v) => { if (v && results.value) { await nextTick(); buildCharts(); } });

const sel = computed(() => drivers.find((d) => d.id === selectedId.value));
const selOrder = computed(() => orders.find((o) => o.id === selectedOrderId.value));

// marker builders live in src/mapMarkers.js; thin wrappers bind selection
const driverIcon = (d) => mkDriverIcon(d, selectedId.value);
const pickupIcon = (o) => mkPickupIcon(o, selectedOrderId.value, HEAT_SEC);
const orderPopup = (o) => mkOrderPopup(o, fmtAge, HEAT_SEC);
function pushFeed(msg, kind = 'info') {
  feed.value.unshift({ at: now(), msg, kind });
  if (feed.value.length > 80) feed.value.pop();
}
function log(d, msg) {
  d.log.unshift(`[${now()}] ${msg}`);
  if (d.log.length > 60) d.log.pop();
}

// ---------- map (R1 Leaflet adapter) ----------
function initMap() {
  map = L.map(mapEl.value, { zoomControl: true }).setView([33.589, -7.62], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  r1map = new R1Map(map, { L });
  map.on('click', (ev) => toggleAreaCell(ev.latlng.lat, ev.latlng.lng)); // H3 editor mode (guarded by `editing`)
  buildBaseGrid();
}
async function buildBaseGrid() {
  const cells = await baseGridCells(activeCity.bbox, 9);
  if (cells.length) r1map.drawH3('base-grid', cells);
}

function renderMap() {
  if (!map) return;
  // ---- orders: 🧍 while FREE; icon removed once R1 assigns the order
  const seenO = new Set();
  for (const o of orders) {
    seenO.add(o.id);
    const taken = o.status !== 'waiting';
    let rec = layers.orders.get(o.id);
    if (!rec) { rec = { pm: null, dm: null }; layers.orders.set(o.id, rec); }
    if (!taken && !rec.pm) {
      const pm = L.marker([o.pickup.lat, o.pickup.lng], { icon: pickupIcon(o), draggable: true }).addTo(map);
      pm.bindPopup(orderPopup(o));
      pm.on('click', () => { if (!editing.value) selectOrder(o.id, false); });
      pm.on('dragend', () => {
        const ll = pm.getLatLng();
        o.pickup.lat = ll.lat; o.pickup.lng = ll.lng;
        onOrderMoved(o, 'pickup');
      });
      rec.pm = pm;
    } else if (!taken && rec.pm) {
      rec.pm.setLatLng([o.pickup.lat, o.pickup.lng]);
      rec.pm.setIcon(pickupIcon(o));
      rec.pm.getPopup()?.setContent(orderPopup(o));
      rec.pm.setOpacity(1);
    } else if (taken && rec.pm) {
      rec.pm.remove(); rec.pm = null;
    }
    const wantDm = o.id === selectedOrderId.value && o.status !== 'canceled';
    if (wantDm && !rec.dm) {
      const dm = L.marker([o.dropoff.lat, o.dropoff.lng], { icon: dropIcon(o), draggable: true }).addTo(map);
      dm.bindPopup(orderPopup(o));
      dm.on('click', () => { if (!editing.value) selectOrder(o.id, false); });
      dm.on('dragend', () => {
        const ll = dm.getLatLng();
        o.dropoff.lat = ll.lat; o.dropoff.lng = ll.lng;
        onOrderMoved(o, 'dropoff');
      });
      rec.dm = dm;
    } else if (wantDm && rec.dm) {
      rec.dm.setLatLng([o.dropoff.lat, o.dropoff.lng]);
      rec.dm.getPopup()?.setContent(orderPopup(o));
    } else if (!wantDm && rec.dm) {
      rec.dm.remove(); rec.dm = null;
    }
  }
  for (const [id, rec] of [...layers.orders]) {
    if (!seenO.has(id)) { rec.pm?.remove(); rec.dm?.remove(); layers.orders.delete(id); }
  }
  // ---- drivers: 🚕 markers + R1 road path + R1 corridor ----
  const seenD = new Set();
  for (const d of drivers) {
    seenD.add(d.id);
    let m = layers.drivers.get(d.id);
    if (!m) {
      m = L.marker([d.pos.lat, d.pos.lng], { icon: driverIcon(d), draggable: true }).addTo(map);
      m.on('click', () => { if (!editing.value) selectDriver(d.id, false); });
      m.bindPopup('');
      m.on('dragend', () => {
        const ll = m.getLatLng();
        let pt = { lat: ll.lat, lng: ll.lng };
        if (d.type === 'petit' && zoneCells.value.length) {
          const g = zoneGeo();
          if (g && !ptInZone(g, pt)) {
            pt = nearestZoneCenter(g, pt);
            d.pos = { ...pt };
            d.trail.push({ ...d.pos });
            d.routeIdx = d.routeGeometry.length;
            d._idleNew = true; d._idleRefreshAt = -60000; d._routeSig = null;
            pushFeed(`${d.id} PETIT snapped back into the zone — petits never leave the edges`, 'warn');
            if (!bridgeDown.value) refreshRoute(d).then(() => renderMap());
            return;
          }
        }
        d.pos = { ...pt };
        d.trail.push({ ...d.pos });
        pushFeed(`${d.id} dragged — R1 rerouting`, 'info');
        if (!bridgeDown.value) refreshRoute(d).then(() => renderMap());
      });
      layers.drivers.set(d.id, m);
    } else {
      m.setLatLng([d.pos.lat, d.pos.lng]);
      m.setIcon(driverIcon(d));
    }
    m.getPopup()?.setContent(`<b>🚕 Taxi ${d.id}</b> [${d.seats}/${d.passengerCapacity || d.capacity}] ${d.privateRide ? '🔒 PRIVATE · ' : ''}${d.available ? '· AVAILABLE' : '· BUSY'}<br><span style="font-family:monospace">${d.pos.lat.toFixed(5)}, ${d.pos.lng.toFixed(5)}</span><br>decider: ${d.deciderId || '—'} · stops: ${d.stops.length}${d.bags ? ` · bags: ${d.bags}` : ''}<br><span style="color:#888">R1 corridor ${d.corridor.length} hex</span>`);
    // R1 road path (black) from remaining geometry
    const geom = d.routeGeometry.slice(Math.max(0, d.routeIdx - 1)).map((p) => [p.lat, p.lng]);
    if (geom.length > 1) r1map.drawRoute(`rte-${d.id}`, geom, { color: '#000', weight: d.id === selectedId.value ? 5 : 3, opacity: 0.9 });
    else r1map.removeLayer(`rte-${d.id}`);
  }
  for (const [id, m] of [...layers.drivers]) {
    if (!seenD.has(id)) { m.remove(); layers.drivers.delete(id); r1map.removeLayer(`rte-${id}`); r1map.removeLayer(`cor-${id}`); }
  }
  renderCorridor(); renderInspectorOverlay(); renderDests(); renderHeat();
  const selD = drivers.find((x) => x.id === selectedId.value);
  if (selD && running.value && follow.value && map) map.panTo([selD.pos.lat, selD.pos.lng], { animate: true });
}

function renderCorridor() {
  const list = showAllCorridors.value ? drivers : drivers.filter((d) => d.id === selectedId.value);
  const seen = new Set();
  for (const d of list) {
    if (!d.corridor?.length) { r1map.removeLayer(`cor-${d.id}`); continue; }
    seen.add(d.id);
    let cells = d.corridor;
    if (cells.length > 600) cells = cells.filter((_, i) => i % Math.ceil(cells.length / 600) === 0);
    r1map.drawCorridor(`cor-${d.id}`, cells, { fillOpacity: d.id === selectedId.value ? 0.3 : 0.14 });
  }
  for (const d of drivers) if (!seen.has(d.id)) r1map.removeLayer(`cor-${d.id}`);
}

function renderInspectorOverlay() {
  r1map.removeLayer('inspector');
  const d = drivers.find((x) => x.id === selectedId.value);
  if (!d || !map) return;
  const L2 = L;
  const group = L2.layerGroup();
  if (d.trail.length > 1) group.addLayer(L2.polyline(d.trail.map((p) => [p.lat, p.lng]), { color: '#000', weight: 3, opacity: 0.8 }));
  const dot = (pt, color, label) => {
    const m = L2.circleMarker([pt.lat, pt.lng], { radius: 6, color: '#000', weight: 1, fillColor: color, fillOpacity: 1 });
    m.bindPopup(`<b>${label}</b><br><span style="font-family:monospace">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</span>`);
    group.addLayer(m);
  };
  d.acceptedPts.forEach((p) => dot(p, '#fff', `Accepted ${p.orderId}`));
  d.pickupPts.forEach((p) => dot(p, '#38bdf8', `Picked up ${p.orderId}`));
  d.dropPts.forEach((p) => dot(p, '#22c55e', `Dropped ${p.orderId}`));
  for (const dec of d.declines.slice(-12)) {
    const o = orders.find((x) => x.id === dec.orderId);
    if (o) group.addLayer(L2.polyline([[d.pos.lat, d.pos.lng], [o.pickup.lat, o.pickup.lng]], { color: '#ef4444', weight: 1.5, dashArray: '6 6' }));
  }
  group.addTo(map);
  r1map.layers.set('inspector', group);
}

function renderDests() {
  r1map.removeLayer('dests');
  const group = L.layerGroup();
  for (const d of drivers) {
    const drops = d.stops.filter((s) => s.type === 'dropoff');
    drops.forEach((s, idx) => {
      const o = orders.find((x) => x.id === s.orderId);
      if (!o || o.id === selectedOrderId.value) return;
      const first = idx === 0;
      const m = L.marker([s.pt.lat, s.pt.lng], {
        icon: L.divIcon({ className: '', iconSize: [70, 28], iconAnchor: [10, 14],
          html: `<div style="display:flex;align-items:center;gap:4px;background:#000;border:1px ${first ? 'solid #fff' : 'dashed #888'};padding:2px 6px;white-space:nowrap;border-radius:999px;">
            <span style="font-size:14px;line-height:1;">${first ? '🏁' : '🏴'}</span>
            <span style="color:${first ? '#fff' : '#aaa'};font:700 10px 'JetBrains Mono',monospace;">${o.id}</span></div>` }),
      });
      const fare = d.bookings.find((b) => b.orderId === o.id)?.fare ?? o.fare;
      m.bindPopup(`<b>${first ? '🏁 Current destination' : '🏴 Queued dropoff'} — ${o.id}</b> · ${o.status}<br>taxi ${d.id} · fare <b>${fare} MAD</b>`);
      group.addLayer(m);
    });
  }
  group.addTo(map);
  r1map.layers.set('dests', group);
}

async function renderHeat() {
  if (bridgeDown.value) { r1map.removeLayer('heat'); return; } // no fetch spam while down
  if (heatFlight || !showHeat.value) { if (!showHeat.value) r1map.removeLayer('heat'); return; }
  const live = orders.filter((o) => o.status === 'waiting');
  if (!live.length) { r1map.removeLayer('heat'); return; }
  heatFlight = true;
  try {
    const zones = await R1.heatmap({
      orders: live.map((o) => ({ pickup: [o.pickup.lat, o.pickup.lng], placedAt: Date.now() / 1000 - (o.ageSec || 0) })),
      now: Date.now() / 1000, resolution: 8,
    });
    r1map.drawHeatmap('heat', zones.filter((z) => z.status !== 'green'));
  } catch (e) { noteBridgeError(e); /* keep last heat on R1 errors */ }
  heatFlight = false;
}

// R1 road path for the clicked order (From → To).
async function loadOrderPath(o) {
  r1map.removeLayer('selpath');
  if (!o) return;
  if (bridgeDown.value) { o.osrm = 'fail'; return; }
  o.osrm = 'loading';
  try {
    const r = await R1.route({ start: [o.pickup.lat, o.pickup.lng], destination: [o.dropoff.lat, o.dropoff.lng] });
    if (selectedOrderId.value !== o.id || !r.geometry.length) { o.osrm = 'fail'; return; }
    o.osrm = 'ok';
    r1map.drawRoute('selpath', r.geometry.map((p) => [p.lat, p.lng]), { color: orderColor(o), weight: 5, opacity: 0.95 });
  } catch (e) { o.osrm = 'fail'; if (!noteBridgeError(e)) pushFeed(`${o.id} R1 road path failed (${e.code || 'error'})`, 'warn'); }
}
watch(selectedOrderId, (id) => loadOrderPath(orders.find((o) => o.id === id)));

function selectOrder(id, fly = false) {
  selectedOrderId.value = id;
  const o = orders.find((x) => x.id === id);
  if (o && fly) map.flyTo([o.pickup.lat, o.pickup.lng], 15, { duration: 0.8 });
  renderMap();
  layers.orders.get(id)?.pm?.openPopup();
}
function selectDriver(id, fly = false) {
  selectedId.value = id;
  const d = drivers.find((x) => x.id === id);
  if (!d) return;
  if (fly) map.flyTo([d.pos.lat, d.pos.lng], 15, { duration: 0.8 });
  else if (follow.value) map.panTo([d.pos.lat, d.pos.lng], { animate: true });
  refreshIcons();
}
function refreshIcons() {
  for (const d of drivers) layers.drivers.get(d.id)?.setIcon(driverIcon(d));
  for (const o of orders) {
    const rec = layers.orders.get(o.id);
    if (rec) { rec.pm?.setIcon(pickupIcon(o)); rec.dm?.setIcon(dropIcon(o)); }
  }
  renderCorridor(); renderInspectorOverlay();
}

// ---------- R1 intelligence ----------
// Ask R1 for a fresh road route + corridor through the stop queue.
async function refreshRoute(d) {
  if (!d.stops.length) {
    d._routeSig = null;            // no persistent signature when idle (shuttle-safe)
    if (bridgeDown.value) return;
    if (d.routeGeometry.length && !d._idleNew) return; // still patrolling its street path
    if (d._idleFetching) return;                        // one in-flight re-route at a time
    if (performance.now() - (d._idleRefreshAt || -60000) < 20000 && d.routeGeometry.length) return; // throttle re-fetch after first patrol
    d._idleRefreshAt = performance.now();
    d._idleNew = false;
    d._idleFetching = true;
    const dest = d.type === 'petit' ? confinedPoint() : randInBBox();
    try {
      const r = await R1.route({ start: [d.pos.lat, d.pos.lng], destination: [dest.lat, dest.lng] });
      if (!r.geometry.length || d.stops.length) return; // stale: got a job meanwhile
      d.routeGeometry = r.geometry.map((p) => ({ lat: p[0] ?? p.lat, lng: p[1] ?? p.lng }));
      let bi = 0, bd = Infinity;
      d.routeGeometry.forEach((p, i) => { const m = haversineM(d.pos, p); if (m < bd) { bd = m; bi = i; } });
      d.routeIdx = bi;
      d.corridor = r.corridor || [];
      d.heading = bearingDeg(d.pos, d.routeGeometry[d.routeIdx]);
    } catch (e) { if (!noteBridgeError(e)) pushFeed(`${d.id} idle patrol reroute failed (${e.code || 'error'})`, 'warn'); }
    finally { d._idleFetching = false; }
    return;
  }
  const sig = stopsSig(d);
  if (d._routeSig === sig) return;
  d._routeSig = sig;
  if (bridgeDown.value) return;
  try {
    const r = await R1.route({
      waypoints: [[d.pos.lat, d.pos.lng], ...d.stops.map((s) => [s.pt.lat, s.pt.lng])],
    });
    if (stopsSig(d) !== sig || !r.geometry.length) return; // stale
    d.routeGeometry = r.geometry.map((p) => ({ lat: p[0] ?? p.lat, lng: p[1] ?? p.lng }));
    let bi = 0, bd = Infinity;
    d.routeGeometry.forEach((p, i) => { const m = haversineM(d.pos, p); if (m < bd) { bd = m; bi = i; } });
    d.routeIdx = bi;
    d.corridor = r.corridor || [];
    d.heading = d.stops.length ? bearingDeg(d.pos, d.stops[0].pt) : d.heading;
  } catch (e) { if (!noteBridgeError(e)) pushFeed(`R1 reroute failed for ${d.id} (${e.code || 'error'})`, 'warn'); }
}

function declineOnce(d, orderId, reason) {
  const r = reason || '';
  const kind = r.includes('corridor') ? 'corridor' : r.includes('capacity') || r.includes('private') ? 'capacity' : 'direction';
  const key = `${orderId}:${kind}`;
  if (d._declineKeys.has(key)) return false;
  d._declineKeys.add(key);
  d.declines.push({ orderId, reason, at: now(), reassignedTo: null });
  log(d, `DECLINE ${orderId}: ${kind === 'corridor' ? 'R1 corridor miss' : r}`);
  return true;
}

// A group order can be split across several taxis; its status reflects the
// WHOLE group. waiting → still needs taxis (served<passengers); riding once
// fully claimed (all pax picked up or en route); completed once dropped off.
function syncGroupStatus(o) {
  if (!o) return;
  if ((o.delivered || 0) >= o.passengers) { o.status = 'completed'; o.state = 'completed'; return; }
  if ((o.served || 0) >= o.passengers) { o.status = 'riding'; o.state = 'in car'; return; }
  o.status = 'waiting';
}

// One auction tick: R1.matchOrders for ordinary orders (fit one taxi),
// then a split pass for large groups that need several taxis. Feed is
// bounded (oldest N waiting orders) so the engine's always-real per-pair
// OSRM validation stays fast — R1 is just a function; the app decides what
// to ask it.
const AUC_ORDERS = 10;
const MAX_SINGLE = 3; // smallest fleet capacity: orders ≤ this fit one taxi

// Reserve `portion` passengers of order o onto taxi d (an R1-validated match).
// Marks the group served <> riding <> completed and gives each taxi stops
// carrying exactly its portion.
function acceptSplit(d, o, m, portion, tag) {
  o.taxis.push(d.id);
  d.bookings.push({
    orderId: o.id, fare: Math.round((o.fare * portion) / (o.passengers || 1) * 10) / 10,
    locked: false, decider: false, portion,
    state: 'accepted', events: [{ at: now(), e: `R1 accepted ${o.id} (portion ${portion}/${o.passengers}) — ${tag}` }],
  });
  d._routeSig = null; // fresh geometry even if this order's points repeat (shuttle return)
  const merged = []; const src = d.stops; let b = 0;
  const shareBags = Math.round(((o.bags || 0) * portion) / (o.passengers || 1));
  for (let k = 0; k < src.length + 2; k++) {
    if (k === m.insertion.pickupIndex) merged.push({ type: 'pickup', orderId: o.id, pt: { ...o.pickup }, pax: portion, bags: shareBags });
    else if (k === m.insertion.dropoffIndex) merged.push({ type: 'dropoff', orderId: o.id, pt: { ...o.dropoff }, pax: portion, bags: shareBags });
    else merged.push(src[b++]);
  }
  d.stops = merged;
  d.acceptedPts.push({ ...o.pickup, orderId: o.id });
  log(d, `ACCEPT ${o.id} portion=${portion}/${o.passengers} ${tag} (+${Math.round(m.insertion.addedM || 0)}m)`);
  pushFeed(`${d.id} ${tag} ${o.id} — carries ${portion}/${o.passengers} pax, fare ${Math.round((o.fare * portion) / o.passengers)} MAD`, 'ok');
  return refreshRoute(d);
}

const NEAR_MAX_RING = 10;    // res-9 hex rings outward until the whole city is covered
const NEAR_MAX_ORDERS = 8;   // cap per tick so per-pair OSRM stays fast

// Per-order operating-area argument for R1.match/matchOrders: Petit Taxi
// orders get the city's drawn H3 area, Grand Taxi + legacy (untagged) orders
// are unrestricted (null). The engine ignores an empty area (no gate).
function areaArgFor(o) {
  if (!o || o.service !== 'petit_taxi') return null;
  const c = active.value;
  return c ? operatingAreaArg(c, 'petit_taxi') : null;
}
function areaArgForActive() {
  const c = active.value;
  return c ? operatingAreaArg(c, 'petit_taxi') : null;
}

// Phase-2 dispatch: the order is offered to the NEAREST available taxi FIRST,
// walking Uber-H3 hexagon rings outward from the cell it was hailed in
// (ring 0 = same hex → ring 1 → … → whole city). The nearest compatible taxi
// accepts; only when no taxi anywhere accepts does the order fall back to the
// city-wide batch/split pass. Large/shared groups are filled by the nearest
// taxis (one portion each) exactly like the split pass, but by proximity.
async function dispatchNearestFirst(waitingAll) {
  // index available taxis by the H3 cell they currently sit in
  const cellIdx = new Map();
  const used = new Set();
  for (const d of drivers) {
    if (d.privateRide || (d.passengerCapacity - d.seats) <= 0) continue;
    const c = h3CellOf(d.pos.lat, d.pos.lng);
    if (!cellIdx.has(c)) cellIdx.set(c, []);
    cellIdx.get(c).push(d);
  }
  const queue = [...waitingAll]
    .filter((o) => o.status === 'waiting')
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || (b.ageSec || 0) - (a.ageSec || 0))
    .slice(0, NEAR_MAX_ORDERS);
  for (const o of queue) {
    if (o.status !== 'waiting') continue;
    const origin = h3CellOf(o.pickup.lat, o.pickup.lng);
    for (let ring = 0; ring <= NEAR_MAX_RING && o.status === 'waiting'; ring++) {
      const cands = [];
      for (const c of h3Ring(origin, ring)) {
        for (const d of cellIdx.get(c) || []) {
          if (!used.has(d.id) && (d.passengerCapacity - d.seats) > 0) cands.push(d);
        }
      }
      if (!cands.length) continue;
      cands.sort((a, b) => haversineM(a.pos, o.pickup) - haversineM(b.pos, o.pickup));
      for (const d of cands) {
        if (o.status !== 'waiting') break;
        const remaining = o.passengers - o.served;
        if (remaining <= 0) break;
        if (o.private && (d.passengerCapacity - d.seats) < remaining) continue; // one taxi must hold the whole ride
        const portion = o.private ? remaining : Math.min(d.passengerCapacity - d.seats, remaining);
        const liveGeom = d.routeGeometry.length
          ? d.routeGeometry.map((p) => [p.lat, p.lng])
          : d.stops.length ? [[d.pos.lat, d.pos.lng], ...d.stops.map((s) => [s.pt.lat, s.pt.lng])] : [];
        let m;
        try {
          m = await R1.match({
            driver: driverPayload(d),
            route: liveGeom,
            order: { ...orderPayload(o), passengers: portion },
            operating_area: areaArgFor(o),
          });
        } catch { continue; }
        if (!m.compatible) continue; // nearest declined; next-nearest gets the chance (batch logs the official reason)
        used.add(d.id);
        const prevServed = o.served;
        o.served = Math.min(o.passengers, o.served + portion);
        if (prevServed === 0 && o.served >= o.passengers) o.waitSec = o.ageSec;
        o.driverId = o.driverId || d.id;
        syncGroupStatus(o);
        await acceptSplit(d, o, m, portion, ring === 0 ? 'NEAR' : `R${ring}`);
        if (o.private) break;
      }
    }
  }
}

async function splitLargeOrders() {
  const big = orders.filter((o) => o.status === 'waiting' && (o.passengers - o.served) > MAX_SINGLE);
  for (const o of big) {
    if (o.status !== 'waiting') continue;
    if (o.private) continue; // a private ride must be one taxi end-to-end
    let remaining = o.passengers - o.served;
    if (remaining <= 0) continue;
    // candidate taxis: not private-locked, has free seats; big (grand) first
    // so we fill a group with the fewest vehicles.
    const cands = drivers
      .filter((d) => !d.privateRide && (d.passengerCapacity - d.seats) > 0)
      .sort((a, b) => (b.passengerCapacity - b.seats) - (a.passengerCapacity - a.seats));
    for (const d of cands) {
      if (o.status !== 'waiting') break;
      remaining = o.passengers - o.served;
      if (remaining <= 0) break;
      const free = d.passengerCapacity - d.seats;
      const portion = Math.min(free, remaining);
      if (portion <= 0) continue;
      const liveGeom = d.routeGeometry.length
        ? d.routeGeometry.map((p) => [p.lat, p.lng])
        : d.stops.length ? [[d.pos.lat, d.pos.lng], ...d.stops.map((s) => [s.pt.lat, s.pt.lng])] : [];
      let m;
      try {
        m = await R1.match({
          driver: driverPayload(d),
          route: liveGeom,
          order: { ...orderPayload(o), passengers: portion }, // per-taxi portion; R1 enforces THIS taxi's capacity
          operating_area: areaArgFor(o),
        });
      } catch { continue; }
      if (!m.compatible) {
        if (declineOnce(d, o.id, m.reasonText)) pushFeed(`${d.id} DECLINE ${o.id} (portion ${portion}) — ${m.reasonText}`, 'warn');
        continue;
      }
      // reserve the portion now; prevents overshoot across taxis
      o.served = Math.min(o.passengers, o.served + portion);
      if (remaining === portion && o.served >= o.passengers) o.waitSec = o.ageSec;
      syncGroupStatus(o);
      await acceptSplit(d, o, m, portion, 'SPLIT');
    }
  }
}

async function auctionTick() {
  // phase 1: nearest-taxi dispatch (H3 ring outward). Every waiting order is
  // offered to the nearest available taxi first; orders that still find no
  // compatible taxi anywhere fall through to the city-wide batch below.
  const allWaiting = orders.filter((o) => o.status === 'waiting');
  await dispatchNearestFirst(allWaiting);
  // private rides (must be one taxi end-to-end, never split) + small orders
  // go through matchOrders; only large SHARED groups go to splitLargeOrders.
  let waiting = orders.filter((o) => o.status === 'waiting' && (o.private || (o.passengers - o.served) <= MAX_SINGLE));
  if (!waiting.length || !drivers.length) { await splitLargeOrders(); return; }
  waiting = waiting.sort((a, b) => (b.ageSec || 0) - (a.ageSec || 0)).slice(0, AUC_ORDERS);
  // Service-aware operating areas: Petit orders are gated by the city's drawn
  // H3 area; Grand + legacy (untagged) orders are unrestricted. Each service
  // batch goes through REAL R1.matchOrders separately so one area never leaks
  // into the wrong service.
  const petit = waiting.filter((o) => o.service === 'petit_taxi');
  const other = waiting.filter((o) => o.service !== 'petit_taxi');
  await auctionPass(petit, areaArgForActive());
  await auctionPass(other, null);
  await splitLargeOrders();
}

/// One R1.matchOrders batch + assignment processing for a homogeneous list.
async function auctionPass(list, operating_area) {
  if (!list.length || !drivers.length) return;
  const pool = drivers.filter((d) => !d.privateRide); // R1 enforces pax/bag capacity; keep private-locked taxis out.
  if (!pool.length) return;
  let res;
  try {
    res = await R1.matchOrders({
      drivers: pool.map(driverPayload),
      routes: pool.map((d) => d.routeGeometry.map((p) => [p.lat, p.lng])),
      orders: list.map(orderPayload),
      waited: list.map((o) => o.ageSec || 0),
      heatAfterS: HEAT_SEC,
      operating_area,
    });
  } catch (e) { if (!noteBridgeError(e)) pushFeed(`R1 matchOrders failed (${e.code || 'error'}) — ${e.message}`, 'warn'); return; }
  for (const s of res.scores || []) {
    if (s.compatible) continue;
    const d = drivers.find((x) => x.id === s.driverId);
    const o = orders.find((x) => x.id === s.orderId);
    if (!d || !o || o.status !== 'waiting') continue;
    if (declineOnce(d, o.id, s.reason)) pushFeed(`${d.id} DECLINE ${o.id} — ${s.reason}`, 'warn');
  }
  for (const a of res.assignments || []) {
    const d = drivers.find((x) => x.id === a.driverId);
    const o = orders.find((x) => x.id === a.orderId);
    if (!d || !o || o.status !== 'waiting') continue;
    if (o.private && d.privateRide) continue;
    // R1 needs a live route for corridor checks; if geometry hasn't landed
    // yet, fall back to the stop waypoint list (refreshed right after).
    const liveGeom = d.routeGeometry.length
      ? d.routeGeometry.map((p) => [p.lat, p.lng])
      : d.stops.length ? [[d.pos.lat, d.pos.lng], ...d.stops.map((s) => [s.pt.lat, s.pt.lng])] : [];
    let m;
    try {
      m = await R1.match({
        driver: driverPayload(d),
        route: liveGeom,
        order: orderPayload(o),
        operating_area: areaArgFor(o),
      });
    } catch { continue; }
    if (!m.compatible) { // R1 OSRM gate disagreed with the heuristic — respect it
      if (declineOnce(d, o.id, m.reasonText)) pushFeed(`${d.id} DECLINE ${o.id} — ${m.reasonText}`, 'warn');
      continue;
    }
    const portion = o.passengers - o.served; // ≤ MAX_SINGLE, so one taxi takes it all
    o.driverId = d.id; o.served = o.passengers; o.taxis.push(d.id); o.waitSec = o.ageSec;
    syncGroupStatus(o);
    if (a.decider || m.decider) { o.lockedFare = o.fare; d.deciderId = o.id; }
    d.bookings.push({
      orderId: o.id, fare: o.fare, locked: !!(a.decider || m.decider), decider: !!(a.decider || m.decider), portion,
      state: 'accepted', events: [{ at: now(), e: `R1 accepted ${o.id} ${(a.decider || m.decider) ? `(DECIDER — fare locked ${o.fare} MAD)` : `(pooled — ${o.fare} MAD)`}` }],
    });
    // apply R1 insertion (indices count merged positions; fixed total)
    d._routeSig = null; // never reuse geometry for repeated points (shuttle/duplicate order)
    const shareBags = Math.round(((o.bags || 0) * portion) / (o.passengers || 1));
    const merged = [];
    const src = d.stops;
    let b = 0;
    for (let k = 0; k < src.length + 2; k++) {
      if (k === m.insertion.pickupIndex) merged.push({ type: 'pickup', orderId: o.id, pt: { ...o.pickup }, pax: portion, bags: shareBags });
      else if (k === m.insertion.dropoffIndex) merged.push({ type: 'dropoff', orderId: o.id, pt: { ...o.dropoff }, pax: portion, bags: shareBags });
      else merged.push(src[b++]);
    }
    d.stops = merged;
    d.acceptedPts.push({ ...o.pickup, orderId: o.id });
    const tag = a.note === 'heat-forced' ? '🔥 HEAT' : (a.decider || m.decider) ? 'DECIDER' : 'POOLED';
    log(d, `ACCEPT ${o.id} ${tag} fare=${o.fare} MAD (+${Math.round(m.insertion.addedM || 0)}m)`);
    pushFeed(`${d.id} ${tag} ${o.id} — corridor R1, fare ${o.fare} MAD locked`, 'ok');
    for (const dd of drivers) for (const dec of dd.declines.filter((x) => x.orderId === o.id && !x.reassignedTo)) dec.reassignedTo = d.id;
    if (o.private) d.privateRide = true;
    await refreshRoute(d);
  }
}

// Local movement along R1 geometry + <100m state machine (app-owned motion).
// ---- Petit operating-zone confinement (app guarantee; R1 also gates) ----
// A res-9 hex "inside the zone" means ≤ ~190 m from one of the zone cell
// centers — use the hex vertex radius as the boundary gate.
const ZONE_CELL_RADIUS_M = 190;
let _zCacheCells = null, _zCacheG = null;
function zoneGeo() {
  const cells = zoneCells.value;
  if (cells === _zCacheCells) return _zCacheG; // same cell array → same geometry
  _zCacheCells = cells;
  if (!cells.length) { _zCacheG = null; return null; }
  const centers = cells.map((c) => { const p = cellToLatLng(c); return { lat: p[0], lng: p[1] }; });
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of centers) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  _zCacheG = { centers, cells, bbox: { minLat, maxLat, minLng, maxLng } };
  return _zCacheG;
}
function ptInZone(g, pt) {
  if (!g) return true; // no zone drawn → unrestricted
  const b = g.bbox, pad = 0.0022; // > vertex radius so in-zone points near the rim never false-negative
  if (pt.lat < b.minLat - pad || pt.lat > b.maxLat + pad || pt.lng < b.minLng - pad || pt.lng > b.maxLng + pad) return false;
  for (const c of g.centers) if (haversineM(pt, c) <= ZONE_CELL_RADIUS_M) return true;
  return false;
}
function nearestZoneCenter(g, from) {
  let best = null, bd = Infinity;
  for (const c of g.centers) { const m = haversineM(from, c); if (m < bd) { bd = m; best = c; } }
  return { ...best };
}
function moveDrivers(dtSec) {
  const zg = zoneGeo(); // petit operating-zone geometry (cached per cell set)
  for (const d of drivers) {
    if (!d.routeGeometry.length || d.routeIdx >= d.routeGeometry.length) {
      if (d.seats === 0 && d.stops.length === 0 && !bridgeDown.value) {
        d._idleNew = true;
        refreshRoute(d).then(() => renderMap());
      }
      continue;
    }
    let travel = d.speed * dtSec;
    while (travel > 0 && d.routeIdx < d.routeGeometry.length) {
      const tgt = d.routeGeometry[d.routeIdx];
      const dist = haversineM(d.pos, tgt);
      if (dist <= travel) { d.pos = { ...tgt }; d.routeIdx++; travel -= dist; }
      else {
        const t = travel / dist;
        d.pos = { lat: d.pos.lat + (tgt.lat - d.pos.lat) * t, lng: d.pos.lng + (tgt.lng - d.pos.lng) * t };
        travel = 0;
      }
    }
    // Petit confinement: a petit that would end this tick outside the zone snaps
    // to the nearest zone hex-center (hard guarantee — petits NEVER leave the
    // edges). Free ones get a fresh in-zone patrol; busy ones just re-route
    // to their (in-zone) stops so service resumes without a stall.
    if (d.type === 'petit' && zg && !ptInZone(zg, d.pos)) {
      const wasFree = d.stops.length === 0 && d.seats === 0;
      d.pos = nearestZoneCenter(zg, d.pos);
      if (!d.stops.length) { d.routeIdx = d.routeGeometry.length; d._idleNew = true; d._idleRefreshAt = -60000; }
      else d.routeIdx = Math.max(0, d.routeIdx - 1);
      d._routeSig = null;
      if (wasFree) pushFeed(`${d.id} PETIT snapped to the zone — free petits never leave the edges`, 'warn');
      else if (performance.now() - (d._clampRefetchAt || 0) > 2000) {
        d._clampRefetchAt = performance.now();
        if (!bridgeDown.value) refreshRoute(d).then(() => renderMap());
      }
    }
    d.trail.push({ ...d.pos });
    if (d.trail.length > 600) d.trail.shift();
    if (d.routeIdx < d.routeGeometry.length) d.heading = bearingDeg(d.pos, d.routeGeometry[d.routeIdx]);
    if (d.routeIdx >= d.routeGeometry.length && d.stops.length) {
      d.pos = { ...d.stops[0].pt }; // geometry ends at snapped waypoint — close out
      d.trail.push({ ...d.pos });
    }
    let changed = false;
    while (d.stops.length && haversineM(d.pos, d.stops[0].pt) < 100) {
      const s = d.stops.shift(); changed = true;
      const o = orders.find((x) => x.id === s.orderId);
      const bk = d.bookings.find((b) => b.orderId === s.orderId);
      const pax = s.pax || ((o && o.passengers) || 1);
      if (s.type === 'pickup') {
        if (o) d.privateRide = !!o.private;
        d.seats = Math.min(d.capacity, d.seats + pax);
        d.bags = d.bags + (s.bags || 0);
        if (bk) { bk.state = 'in car'; bk.events.push({ at: now(), e: `in position → in car: +${pax} pax${s.bags ? `, +${s.bags} bags` : ''}` }); }
        if (o) {
          d.pickupPts.push({ ...o.pickup, orderId: o.id });
          o.served = Math.min(o.passengers, (o.served || 0) + pax);
          syncGroupStatus(o);
        }
        log(d, `PICKUP ${s.orderId} pax=${d.seats}/${d.capacity} bags=${d.bags}/${d.bagCapacity || '∞'}`);
        if (d.privateRide || d.seats >= d.capacity || (d.bagCapacity && d.bags >= d.bagCapacity)) { d.available = false; log(d, d.privateRide ? 'PRIVATE — hidden from R1 matcher' : 'FULL — hidden from R1 matcher'); }
      } else {
        if (o) { o.delivered = (o.delivered || 0) + pax; d.dropPts.push({ ...o.dropoff, orderId: o.id }); }
        d.seats = Math.max(0, d.seats - pax);
        d.bags = Math.max(0, d.bags - (s.bags || 0));
        if (bk) { bk.state = 'completed'; bk.events.push({ at: now(), e: `completed (dropoff <100m verified, ${pax} pax)` }); }
        if (o) { syncGroupStatus(o); }
        log(d, `DROPOFF ${s.orderId} pax=${d.seats}/${d.capacity} bags=${d.bags}${o ? ` (order ${o.delivered}/${o.passengers})` : ''}`);
      }
    }
    if (changed && !bridgeDown.value) refreshRoute(d).then(() => renderMap());
    if (d.seats === 0 && !d.stops.some((s) => s.type === 'pickup') && d.stops.length === 0) {
      if (!d.available || d.deciderId) log(d, 'RESET — available, ready for new R1 Decider');
      d.available = true; d.deciderId = null; d.corridor = [];
    }
    // Idle taxi whose patrol route ran out: flag it so refreshRoute gives it a
    // new random road route (every taxi always follows OSRM streets).
    if (d.seats === 0 && d.stops.length === 0 && d.routeIdx >= d.routeGeometry.length) {
      d._idleNew = true;
      d._idleRefreshAt = -60000; // finished: fetch a new patrol street now
      refreshRoute(d).then(() => renderMap());
    }
  }
}

// ---------- fleet & orders (app owns entities; R1 prices + routes them) ----------
async function spawnTraffic(nD = 6, nO = 10) {
  for (let i = 0; i < nD; i++) {
    const d = makeDriver({ type: i % 3 === 2 ? 'grand' : 'petit' }); // 2 petit : 1 grand mix
    if (d.type === 'petit' && zoneCells.value.length) { const p = confinedPoint(); d.pos = { ...p }; d.trail = [{ ...p }]; } // petit confined to the zone
    drivers.push(d);
  }
  for (let i = 0; i < nO; i++) {
    // Zone order guarantee: when a Petit zone exists, spawned orders pick up
    // AND drop off inside it — petits' dispatches, pickups & drops stay in-zone.
    let o;
    if (zoneCells.value.length) {
      const pick = confinedPoint();
      let drop = confinedPoint(); let guard = 0;
      while (haversineM(pick, drop) < 500 && guard++ < 12) drop = confinedPoint();
      o = makeRandomOrderShell({ service: 'petit_taxi', pickup: pick, dropoff: drop });
      o.pickupCell = h3CellOf(pick.lat, pick.lng);
      o.dropoffCell = h3CellOf(drop.lat, drop.lng);
    } else {
      o = makeRandomOrderShell();
    }
    orders.push(o);
    if (!bridgeDown.value) priceOrder(o).then(() => renderMap()).catch(() => {});
  }
  pushFeed(`Spawned ${nD} taxis (petit+grand) + ${nO} orders — mixed demand (groups/bags/private/urgent)`, 'ok');
  renderMap();
}
function addTaxi(type = taxiType.value) {
  if (type === 'petit' && !zoneCells.value.length) { pushFeed('No petit zone drawn yet — petit taxis are confined to it', 'warn'); return; }
  // Both fleets START on the drawn zone: petits stay confined to it forever;
  // grands spawn on it too (tests, dashboard) then roam the whole city.
  let pos;
  if (zoneCells.value.length) pos = confinedPoint();
  else { const c = map ? map.getCenter() : { lat: 33.589, lng: -7.62 }; pos = { lat: c.lat + (Math.random() - 0.5) * 0.01, lng: c.lng + (Math.random() - 0.5) * 0.01 }; }
  const d = makeDriver({ type, pos });
  drivers.push(d);
  pushFeed(`${type === 'grand' ? 'Grand taxi' : 'Petit taxi'} ${d.id} added (${d.capacity} seats) — stations inside the drawn zone, ${type === 'petit' ? 'confined to it forever' : 'roams the whole city'}. drag the icon anywhere`, 'ok');
  renderMap();
}
function removeSelectedTaxi() {
  const i = drivers.findIndex((x) => x.id === selectedId.value);
  if (i < 0) return;
  const d = drivers[i];
  for (const o of orders.filter((x) => x.taxis && x.taxis.includes(d.id) && x.status !== 'completed')) {
    o.taxis = o.taxis.filter((t) => t !== d.id);
    if (!o.taxis.length && o.status !== 'completed') { o.driverId = null; syncGroupStatus(o); }
  }
  drivers.splice(i, 1);
  pushFeed(`${d.type === 'grand' ? 'Grand' : 'Petit'} taxi ${d.id} removed — its orders returned to R1 pool`, 'warn');
  selectedId.value = null;
  renderMap();
}
async function addOrder() {
  let o;
  if (zoneCells.value.length) {
    // In-zone order guarantee (same as spawned + live demand).
    const pick = confinedPoint();
    let drop = confinedPoint(); let guard = 0;
    while (haversineM(pick, drop) < 500 && guard++ < 12) drop = confinedPoint();
    o = makeRandomOrderShell({ service: 'petit_taxi', pickup: pick, dropoff: drop });
    o.pickupCell = h3CellOf(pick.lat, pick.lng);
    o.dropoffCell = h3CellOf(drop.lat, drop.lng);
  } else {
    o = makeRandomOrderShell();
  }
  orders.push(o);
  selectedOrderId.value = o.id;
  try { await priceOrder(o); } catch (e) { if (!noteBridgeError(e)) pushFeed(`R1 pricing failed (${e.code || 'error'})`, 'warn'); }
  pushFeed(`Order ${o.id} added — R1 priced ${o.fare} MAD`, 'ok');
  renderMap();
}
function deleteOrder() {
  const i = orders.findIndex((x) => x.id === selectedOrderId.value);
  if (i < 0) return;
  const o = orders[i];
  for (const d of drivers) {
    if (d.stops.some((s) => s.orderId === o.id)) {
      d.stops = d.stops.filter((s) => s.orderId !== o.id);
      d.bookings = d.bookings.filter((b) => b.orderId !== o.id);
      if (!bridgeDown.value) refreshRoute(d).then(() => renderMap());
    }
  }
  orders.splice(i, 1);
  selectedOrderId.value = null;
  renderMap();
}
async function spawnScenario4() {
  const A = makeDriver({ pos: { lat: 33.5900, lng: -7.6300 }, id: 'T01' });
  const B = makeDriver({ pos: { lat: 33.5830, lng: -7.6000 }, id: 'T02' });
  drivers.push(A, B);
  const mk = async (id, px, py, dx, dy) => {
    const o = makeOrderShell({ id, pickup: { lat: px, lng: py }, dropoff: { lat: dx, lng: dy } });
    orders.push(o);
    try { await priceOrder(o); } catch {}
    return o;
  };
  await Promise.all([
    mk('U1', 33.5910, -7.6280, 33.5962, -7.5888),
    mk('U2', 33.5920, -7.6200, 33.5980, -7.5950),
    mk('U3', 33.5930, -7.6120, 33.5990, -7.5900),
    mk('U4', 33.5860, -7.6450, 33.5805, -7.6166),
  ]);
  selectedId.value = A.id;
  pushFeed('Scenario User 4 loaded — R1 decides: A eastbound, U4 backtracks → expect DECLINE + reassign to B', 'warn');
  renderMap();
}
function onOrderMoved(o, which) {
  const d = drivers.find((x) => x.id === o.driverId);
  if (d && (o.status === 'assigned' || o.status === 'riding')) {
    for (const s of d.stops) if (s.orderId === o.id && ((which === 'pickup' && s.type === 'pickup') || (which === 'dropoff' && s.type === 'dropoff'))) s.pt = { ...(which === 'pickup' ? o.pickup : o.dropoff) };
    if (!bridgeDown.value) refreshRoute(d).then(() => renderMap());
    pushFeed(`${o.id} ${which} moved — R1 rerouting ${d.id}`, 'info');
  } else {
    if (!bridgeDown.value) priceOrder(o).then(() => renderMap()).catch(() => {});
    pushFeed(`${o.id} ${which} → ${o[which].lat.toFixed(4)},${o[which].lng.toFixed(4)}`, 'info');
  }
  renderMap();
}

function reset() {
  testCfg.active = false;
  drivers.splice(0); orders.splice(0); feed.value = [];
  selectedId.value = null; selectedOrderId.value = null;
  tickCount.value = 0; simClock.value = 0; resetIds();
  [...layers.drivers.values()].forEach((l) => l.remove()); layers.drivers.clear();
  for (const rec of layers.orders.values()) { rec.pm?.remove(); rec.dm?.remove(); }
  layers.orders.clear();
  r1map?.clear();
  renderArea();
  pushFeed('Reset. Taxis hold position until you press START.', 'info');
}

// ---------- city config + H3 operating-area editor ----------
// The H3 cell set is the source of truth for Petit pickups. Cells render as
// sky-blue hex polygons on the map; SAVE commits them into the city config and
// that snapshot is what matching + order generation read next.
function renderArea() {
  if (!r1map) return;
  if (editing.value && editor.value) {
    r1map.removeLayer('area');
    if (editorHasArea(editor.value)) r1map.drawH3('area', [...editor.value.cells], { color: '#38bdf8', weight: 1.2, opacity: 0.95, fill: true, fillColor: '#38bdf8', fillOpacity: 0.3, interactive: false });
    drawEditorEdges();
    return;
  }
  const c = active.value;
  const cells = c ? areaCells(c, 'petit_taxi') : [];
  if (cells.length) r1map.drawH3('area', cells, { color: '#38bdf8', weight: 1, opacity: 0.75, fill: true, fillColor: '#38bdf8', fillOpacity: 0.16, interactive: false });
  else r1map.removeLayer('area');
}
function drawEditorEdges() {
  const e = editor.value;
  if (!e) return;
  const rings = e.polys.map((r) => r.slice());
  if (e.verts.length >= 2) {
    const open = e.verts.slice();
    if (open.length >= 3) open.push([e.verts[0][0], e.verts[0][1]]);
    rings.push(open);
  }
  if (rings.length) r1map.drawPolys('area-edges', rings, { color: '#22d3ee', weight: 2.5, opacity: 0.95 });
  else r1map.removeLayer('area-edges');
  const allVerts = [];
  for (const r of e.polys) for (const v of r.slice(0, -1)) allVerts.push(v);
  for (const v of e.verts) allVerts.push(v);
  const kept = new Set();
  allVerts.forEach((v, vi) => {
    const id = `poly-vert-${vi}`;
    kept.add(id);
    const vm = r1map.getMarker(id);
    if (vm) vm.setLatLng([v[0], v[1]]);
    else r1map.addMarker(id, [v[0], v[1]], { color: '#22d3ee', radius: 5, weight: 1, fillOpacity: 1 });
  });
  for (const id of [...r1map.markers.keys()]) if (id.startsWith('poly-vert-') && !kept.has(id)) r1map.removeMarker(id);
}
function clearEditorOverlays() {
  r1map?.removeLayer('area-edges');
  if (r1map) for (const id of [...r1map.markers.keys()]) if (id.startsWith('poly-vert-')) r1map.removeMarker(id);
}
function selectCity(id) {
  activeCityId.value = id;
  const c = active.value;
  if (!c) return;
  if (CITIES[c.city_name]) setCity(c.city_name);
  if (map && c.center && Array.isArray(c.center)) map.setView([c.center[0], c.center[1]], 13);
  buildBaseGrid();
  renderArea(); renderMap();
  pushFeed(`Active city → ${c.city_name}`, 'info');
}
function addCity() {
  const name = (newCityName.value || '').trim();
  if (!name) { pushFeed('City name required', 'warn'); return; }
  if (cities.value.some((c) => c.city_name.toLowerCase() === name.toLowerCase())) { pushFeed(`City "${name}" already exists`, 'warn'); return; }
  const c = createCity({ city_name: name, petit_taxi: true, grand_taxi: true });
  if (!c.center) c.center = [33.589, -7.62];
  if (!c.bbox) c.bbox = CITIES.Casablanca.bbox;
  if (!CITIES[name]) CITIES[name] = { center: c.center, bbox: c.bbox, pois: [...CITIES.Casablanca.pois] };
  cities.value.push(c);
  newCityName.value = '';
  selectCity(c.city_id);
  pushFeed(`City "${name}" created (petit+grand enabled). Draw an H3 operating area now.`, 'ok');
}
function toggleService(svc) {
  const c = active.value;
  if (!c || !c.services) return;
  c.services[svc] = !c.services[svc];
  pushFeed(`${svc === 'petit_taxi' ? 'Petit taxi' : 'Grand taxi'} now ${c.services[svc] ? 'ENABLED' : 'DISABLED'} in ${c.city_name}`, 'info');
}
function editArea(mode = 'cells') {
  const c = active.value;
  if (!c) { pushFeed('No city yet — create it in the SETUP wizard', 'warn'); return; }
  if (!serviceEnabled(c, 'petit_taxi')) { pushFeed('Enable the 🐟 Petit taxi service first (CITY & ZONES)', 'warn'); return; }
  showCityConfig.value = false;
  wizard.open = false; // the zone-drawing modal must not block map clicks
  editor.value = makeEditor('petit_taxi');
  loadEditor(c, editor.value);
  editor.value.mode = mode;
  editing.value = true;
  pushFeed(mode === 'edges' ? 'ZONE EDGES — click the outline to draw: the surface auto-fills with hexes as you place points. Click INSIDE a hex to remove it. 🔒 LOCK BLOB between blobs (corridor auto-links). ✓ DONE commits.' : 'H3 operating-area editor — click map hexes to select/deselect petit pick cells. SAVE to commit.', 'info');
  renderArea();
}
async function toggleAreaCell(lat, lng) {
  if (!editing.value || !editor.value) return;
  const e = editor.value;
  if (e.mode === 'edges') { await edgesClick(e, lat, lng); renderArea(); return; }
  toggleCell(e, h3CellOf(lat, lng));
  renderArea();
}
// Edges mode = live auto-fill: every click ON the boundary (or on empty map)
// places a NEW VERTEX (the polygon fills itself with hexes right away); every
// click INSIDE a filled hexagon ERASES that hexagon (pinned in `excluded` so a
// later re-fill never resurrects it). Distinguish the two by distance to the
// outline polyline in screen pixels — boundary clicks extend, interior shave.
// The raster itself is computed by R1 (`area`) for every re-fill; the local
// refreshAutoFill (h3-js) only runs as a fallback if the engine is offline.
async function edgesClick(e, lat, lng) {
  const cell = h3CellOf(lat, lng);
  const px = map.latLngToContainerPoint(L.latLng(lat, lng));
  const near = nearOutline(px, e);
  if (!near && e.cells.has(cell)) {
    e.excluded.add(cell);
    e.cells.delete(cell);
    e.order = [...e.cells];
    e.dirty = true;
    return;
  }
  if (!near && e.excluded.has(cell)) {
    e.excluded.delete(cell);
    await autoFillZone(e); // bring the hex back if it sits under a fill
    return;
  }
  addVertex(e, { lat, lng });
  await autoFillZone(e);
}
function nearOutline(px, e) {
  const segs = [];
  for (const r of e.polys) {
    const rr = r.map((v) => map.latLngToContainerPoint(L.latLng(v[0], v[1])));
    for (let i = 0; i < rr.length - 1; i++) segs.push([rr[i], rr[i + 1]]); // locked rings carry their closing segment
  }
  const open = e.verts.map((v) => map.latLngToContainerPoint(L.latLng(v[0], v[1])));
  for (let i = 0; i < open.length - 1; i++) segs.push([open[i], open[i + 1]]);
  for (const [a, b] of segs) if (distToSeg(px, a, b) < 10) return true;
  for (const p of open) if (Math.hypot(px.x - p.x, px.y - p.y) < 10) return true;
  return false;
}
function distToSeg(px, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(px.x - a.x, px.y - a.y);
  const t = Math.max(0, Math.min(1, ((px.x - a.x) * dx + (px.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px.x - (a.x + t * dx), px.y - (a.y + t * dy));
}
/// Re-raster the drawn zone through the R1 engine (`area`), applying the
/// committed cells back onto the editor. Falls back to the local h3-js
/// refreshAutoFill if the engine is unreachable — drawing never blocks.
async function autoFillZone(e) {
  if (!e || e.mode !== 'edges') return;
  try {
    const rings = ringsOfEditor(e);
    if (!rings.length) { applyAreaCells(e, []); return; }
    const res = await R1.area({ rings, link: true, exclude: [...e.excluded] }, { routing: 'mock' });
    if (res && Array.isArray(res.cells)) { applyAreaCells(e, res.cells); return; }
  } catch { /* engine offline → local fallback below */ }
  refreshAutoFill(e);
}
function switchEditorMode(mode) {
  if (editor.value) { editor.value.mode = mode; renderArea(); }
}
async function keepBlob() {
  // lock the current vertex run as a blob and auto-fill (blobs auto-link by corridor)
  if (editing.value && editor.value?.mode === 'edges') {
    closePolygon(editor.value);
    await autoFillZone(editor.value);
    renderArea();
    pushFeed(`${editor.value.polys.length} blob${editor.value.polys.length > 1 ? 's' : ''} locked — draw another, or ✓ DONE. Corridor auto-links blobs.`, 'info');
  }
}
async function deleteLastVertex() {
  if (editing.value && editor.value?.mode === 'edges') { removeLastVertex(editor.value); await autoFillZone(editor.value); renderArea(); }
}
function clearEditorEdges() {
  if (editing.value && editor.value?.mode === 'edges') { clearVerts(editor.value); editor.value.polys = []; editor.value.excluded.clear(); refreshAutoFill(editor.value); renderArea(); }
}
function deleteLastEditorCell() {
  if (!editing.value || !editor.value) return;
  removeLastCell(editor.value);
  renderArea();
}
function clearEditorCells() {
  if (!editing.value || !editor.value) return;
  clearCells(editor.value);
  renderArea();
}
function saveArea() {
  if (!editing.value || !editor.value) return;
  saveEditor(active.value, editor.value);
  editing.value = false;
  editor.value = null;
  clearEditorOverlays();
  const c = active.value;
  const n = areaCells(c, 'petit_taxi').length;
  if (wizard.step === 'zone') {
    if (!n) { wizard.open = true; pushFeed('Zone is empty — click the map to trace the zone (it auto-fills with hexes), then ✓ DONE', 'warn'); renderArea(); renderMap(); return; }
    c.center = zoneCentroid(c);
    c.bbox = zoneBounds(c);
    if (CITIES[c.city_name]) { CITIES[c.city_name].center = [...c.center]; CITIES[c.city_name].bbox = { ...c.bbox }; } // keep the geo store aligned
    testForm.city = c.city_name; // pin the wizard-created city so startTest targets IT
    wizard.step = 'config';
    wizard.open = true;
    pushFeed(`Petit zone committed — ${n} H3 cells (blobs + corridor). City auto-centered on the zone. Now the TEST CONFIG.`, 'ok');
    renderArea(); renderMap();
    return;
  }
  pushFeed(`H3 operating area saved — ${n} cells for ${c.city_name} petit pickups. Matching + generation now use them.`, 'ok');
  renderArea(); renderMap();
}
function cancelEditArea() {
  editing.value = false;
  editor.value = null;
  clearEditorOverlays();
  if (wizard.step === 'zone') wizard.open = true;
  renderArea();
}
function clearSavedArea() {
  const c = active.value;
  if (!serviceEnabled(c, 'petit_taxi')) return;
  setArea(c, 'petit_taxi', { h3_resolution: H3_RES, allowed_cells: [] });
  pushFeed(`Petit H3 area for ${c.city_name} cleared — petit orders unrestricted until you redraw it`, 'warn');
  renderArea(); renderMap();
}
function pushGenerated(res) {
  if (!res.ok) return 0;
  for (const g of res.orders) {
    const shell = makeOrderShell({
      id: `G${String(++genCounter).padStart(3, '0')}`,
      pickup: g.pickup, dropoff: g.dropoff,
      passengers: g.passengers, bags: g.bags, priority: g.priority, private: g.private,
      service: g.service,
    });
    shell.pickupCell = g.pickupCell;
    shell.dropoffCell = g.dropoffCell;
    orders.push(shell);
    if (!bridgeDown.value) priceOrder(shell).then(() => renderMap()).catch(() => {});
  }
  return res.count;
}
async function generateOrdersUI() {
  const c = active.value;
  if (!c) { pushFeed('No city yet — run the SETUP wizard', 'warn'); return; }
  const svc = genForm.service;
  const res = generateOrders(svc, c, {
    count: genForm.count,
    passengersMin: genForm.minPax, passengersMax: genForm.maxPax,
    bagsMin: genForm.minBags, bagsMax: genForm.maxBags,
    priority_distribution: { normal: genForm.prioNormal, high: genForm.prioHigh, urgent: genForm.prioUrgent, emergency: genForm.prioEmergency },
    private_probability: genForm.privateProb / 100,
    citySampler: { randPOIBiased },
  });
  if (!res.ok) {
    pushFeed(`⛔ ${res.code} — ${svc === 'petit_taxi' ? 'Petit taxi is disabled or has no H3 area drawn' : 'Grand taxi is disabled'}. Fix it in CITY & ZONES, then generate again.`, 'warn');
    return;
  }
  pushGenerated(res);
  pushFeed(`Generated ${res.count} ${svc === 'petit_taxi' ? 'petit' : 'grand'} orders from ${c.city_name} config — REAL R1.match will apply service + operating area`, 'ok');
  renderMap();
}

// ---------- SETUP wizard ----------
function createWizardCity() {
  const name = wizard.name.trim();
  if (!name) { pushFeed('Enter a city name first', 'warn'); return; }
  const existing = cities.value.find((c) => c.city_name.toLowerCase() === name.toLowerCase());
  if (existing) {
    // Reuse for a NEW TEST: fresh run, fresh zone — select it, clear the Petit
    // edges, then the setup wizard jumps straight to zone drawing.
    selectCity(existing.city_id);
    setArea(existing, 'petit_taxi', { h3_resolution: H3_RES, allowed_cells: [] });
    wizard.name = '';
    wizard.step = 'zone';
    pushFeed(`City "${existing.city_name}" reused for a NEW TEST — its Petit zone is cleared; draw fresh edges on the map.`, 'warn');
    renderArea(); renderMap();
    return;
  }
  const c = createCity({ city_name: name, petit_taxi: true, grand_taxi: true });
  c.center = [33.589, -7.62];
  c.bbox = CITIES.Casablanca.bbox;
  if (!CITIES[name]) CITIES[name] = { center: c.center, bbox: c.bbox, pois: [...CITIES.Casablanca.pois] };
  cities.value.push(c);
  wizard.name = '';
  selectCity(c.city_id);
  wizard.step = 'zone';
  pushFeed(`City "${name}" created (petit + grand). Now draw the Petit operating zone — polygon edges → AUTO-COMPLETE.`, 'ok');
}
function placeFleet(n, type) {
  const quantity = Math.max(1, Math.min(50, +n || 1));
  if (type === 'petit' && !zoneCells.value.length) { pushFeed('Draw the zone first — petit taxis are confined to it', 'warn'); return; }
  for (let i = 0; i < quantity; i++) addTaxi(type);
  pushFeed(`Fleet placed: ${quantity} ${type === 'petit' ? 'petit taxis (confined to the zone)' : 'grand taxis (city-wide)'}`, 'ok');
}
function wizardGenerate() {
  const c = active.value;
  if (!c) { pushFeed('No city yet — run the SETUP wizard', 'warn'); return; }
  let total = 0;
  const petit = generateOrders('petit_taxi', c, {
    count: 6, passengersMin: 1, passengersMax: 3, bagsMin: 0, bagsMax: 2,
    priority_distribution: { normal: 0.7, high: 0.2, urgent: 0.08, emergency: 0.02 },
    private_probability: 0.1,
  });
  if (petit.ok) total += pushGenerated(petit);
  else pushFeed(`⛔ ${petit.code} — petit orders need the zone (drawn to the map first)`, 'warn');
  if (serviceEnabled(c, 'grand_taxi')) {
    const grand = generateOrders('grand_taxi', c, {
      count: 3, passengersMin: 1, passengersMax: 6, bagsMin: 0, bagsMax: 3,
      priority_distribution: { normal: 0.7, high: 0.2, urgent: 0.08, emergency: 0.02 },
      private_probability: 0.05,
      citySampler: { randPOIBiased },
    });
    if (grand.ok) total += pushGenerated(grand);
  }
  pushFeed(`Wizard demand: ${total} orders — petit confined to the zone + grand city-wide. Press ▶ START.`, 'ok');
  renderMap();
}
// Scratch orders (Q##, P##) are re-created deterministically on every run.
function clearScratchOrders() {
  for (let i = orders.length - 1; i >= 0; i--) {
    const o = orders[i];
    if (!/^[QP]/.test(o.id)) continue;
    const d = drivers.find((x) => x.id === o.driverId);
    if (d) { d.stops = d.stops.filter((s) => s.orderId !== o.id); d.bookings = d.bookings.filter((b) => b.orderId !== o.id); }
    orders.splice(i, 1);
  }
}
// THE "case of 4" quick scenario: ONE petit taxi + exactly 3 orders, each with
// a DIFFERENT config (1-solo ·2-group+bags+urgent ·3-private) — all in-zone.
function quickTest() {
  const c = active.value;
  if (!c) { pushFeed('Create a city first', 'warn'); return; }
  if (!zoneCells.value.length) { pushFeed('Draw the operating zone first — petit taxis/orders live inside it', 'warn'); return; }
  clearScratchOrders();
  addTaxi('petit');
  const configs = [
    { id: 'Q1', passengers: 1, bags: 0, priority: 0, private: false, note: 'solo · normal · shared' },
    { id: 'Q2', passengers: 2, bags: 1, priority: 2, private: false, note: 'group 🧳 · urgent' },
    { id: 'Q3', passengers: 1, bags: 0, priority: 1, private: true, note: 'private 🔒 · high' },
  ];
  for (const cfg of configs) {
    const pick = confinedPoint();
    let drop = confinedPoint(); let guard = 0;
    while (haversineM(pick, drop) < 500 && guard++ < 12) drop = confinedPoint();
    const shell = makeOrderShell({
      id: cfg.id, pickup: pick, dropoff: drop,
      passengers: cfg.passengers, bags: cfg.bags, priority: cfg.priority, private: cfg.private,
      service: 'petit_taxi',
    });
    shell.pickupCell = h3CellOf(pick.lat, pick.lng);
    shell.dropoffCell = h3CellOf(drop.lat, drop.lng);
    orders.push(shell);
    if (!bridgeDown.value) priceOrder(shell).then(() => renderMap()).catch(() => {});
  }
  pushFeed('🚕 QUICK TEST · 1 petit taxi + 3 orders, 3 DIFFERENT configs (solo · urgent group+bags · private) — press ▶ START', 'ok');
  renderMap();
}
// QUICK TEST as a RUN: arm the real test timer around the case-of-4. One petit
// taxi + 3 distinct-config orders, all in-zone, running at ×5 → RESULTS at the end.
function runQuickTest() {
  const c = active.value;
  if (!c) { pushFeed('Create a city first', 'warn'); return; }
  if (!zoneCells.value.length) { pushFeed('Draw the operating zone first — petit taxis/orders live inside it', 'warn'); return; }
  setPricing({ rate: +testForm.rate, base: +testForm.base, mode: testForm.mode, night: testForm.night, bags: testForm.bags, bagsFee: +testForm.bagsFee });
  clearScratchOrders();
  quickTest();
  runSeries = []; lastSeriesMin = 0;
  simClock.value = 0; testCfg.active = true; testCfg.city = c.city_name; testCfg.endAt = +testForm.duration;
  speed.value = +testForm.speed || 5; liveTraffic.value = false; testForm.priority = false;
  running.value = true; showSetup.value = false; wizard.open = false; showResults.value = false;
  pushFeed('⚡ QUICK TEST ARMED — case-of-4 on R1 core, timer running, RESULTS at the end', 'ok');
}
// Edge probes: orders deliberately dropped OUTSIDE the Petit zone to prove the
// boundary. The R1 operating-area gate DECLINES every pickup (the feed shows
// why), so no taxi ever crosses the edge for them. NEVER priced, NEVER a ride.
let probeSeq = 0;
function addEdgeProbes(n = 3) {
  const cells = zoneCells.value;
  if (!cells.length) { pushFeed('Draw the Petit zone first — edge probes test its boundary', 'warn'); return; }
  const g = zoneGeo();
  let placed = 0;
  for (let i = 0; i < n; i++) {
    const cc = cellToLatLng(cells[Math.floor(Math.random() * cells.length)]);
    const ang = Math.random() * Math.PI * 2;
    const dist = 900 + Math.random() * 1100; // 0.9-2.0 km past the edge
    const lat = cc[0] + (dist * Math.cos(ang)) / 111320;
    const lng = cc[1] + (dist * Math.sin(ang)) / (111320 * Math.cos((cc[0] * Math.PI) / 180));
    const pt = { lat, lng };
    if (g && ptInZone(g, pt)) { i--; continue; } // must land OUTSIDE the zone
    const mount = makeOrderShell({ id: `XP${String(++probeSeq).padStart(2, '0')}`, pickup: pt, dropoff: pt, service: 'petit_taxi', passengers: 1, bags: 0, priority: 0, private: false });
    mount.dropoff = { ...mount.pickup }; // same corner — never a real ride
    mount.probe = true; mount.fare = null; mount.directKm = 0;
    mount.pickupCell = h3CellOf(lat, lng); mount.dropoffCell = mount.pickupCell;
    orders.push(mount); placed++;
  }
  pushFeed(`⛺ ${placed} EDGE PROBE order${placed === 1 ? '' : 's'} OUTSIDE the Petit zone — NO fare; R1 declines every pickup (area gate) so nobody leaves the edges`, 'warn');
  renderMap();
}
// Random mixed batch covering EVERY priority tier 0-3 (group/bags/private mix).
function shootRandomBatch({ count = 12, forceTiers = true } = {}) {
  const zone = zoneCells.value;
  clearScratchOrders();
  const sampler = () => (zone.length ? confinedPoint() : randInBBox());
  const mkAttrs = (prio) => ({
    passengers: 1 + Math.floor(Math.random() * 3),
    bags: Math.random() < 0.35 ? 1 + Math.floor(Math.random() * 2) : 0,
    priority: prio,
    private: Math.random() < 0.15,
  });
  const specs = [];
  if (forceTiers) for (const t of [0, 1, 2, 3]) specs.push(mkAttrs(t));
  for (let k = specs.length; k < count; k++) specs.push(mkAttrs(Math.floor(Math.random() * 4)));
  for (let i = 0; i < specs.length; i++) {
    const svc = zone.length ? (Math.random() < 0.7 ? 'petit_taxi' : 'grand_taxi') : 'grand_taxi';
    const pick = sampler();
    let drop = sampler(); let guard = 0;
    while (haversineM(pick, drop) < 500 && guard++ < 12) drop = sampler();
    const shell = makeOrderShell({ id: `P${String(i + 1).padStart(2, '0')}`, pickup: pick, dropoff: drop, ...specs[i], service: svc });
    shell.pickupCell = h3CellOf(pick.lat, pick.lng);
    shell.dropoffCell = h3CellOf(drop.lat, drop.lng);
    orders.push(shell);
    if (!bridgeDown.value) priceOrder(shell).then(() => renderMap()).catch(() => {});
  }
  pushFeed(`🔀 PRIORITY BATCH: ${specs.length} orders — every tier 0-3 + random groups/bags/private${zone.length ? ', petit confined to zone' : ''}. Press ▶ START.`, 'ok');
  renderMap();
}
function priorityShooter() { shootRandomBatch({ count: 12 }); }
// A random hail dropped INSIDE the petit zone (petit service, confined pick+drop).
// Honors the NEW TEST config: PRIORITY tiers 0-3 and/or BAGS when enabled.
function liveHail(tier) {
  const zone = zoneCells.value.length;
  let o;
  if (zone) {
    const pick = confinedPoint();
    let drop = confinedPoint(); let guard = 0;
    while (haversineM(pick, drop) < 500 && guard++ < 12) drop = confinedPoint();
    o = makeRandomOrderShell({ service: 'petit_taxi', pickup: pick, dropoff: drop });
    o.pickupCell = h3CellOf(pick.lat, pick.lng);
    o.dropoffCell = h3CellOf(drop.lat, drop.lng);
  } else {
    o = makeRandomOrderShell();
  }
  if (tier !== undefined) { o.priority = Math.max(0, Math.min(3, tier)); } // forced tier (seed wave guarantees 0-3)
  else if (testForm.priority && o.priority === 0 && Math.random() < 0.85) o.priority = Math.floor(Math.random() * 4);
  if (testForm.bags && o.bags === 0 && Math.random() < 0.5) o.bags = 1 + Math.floor(Math.random() * 2);
  orders.push(o);
  if (!bridgeDown.value) priceOrder(o).then(() => renderMap()).catch(() => {});
  if (bridgeDown.value) renderMap();
  return o;
}
// Cumulative snapshot of the running test: created / accepted / waiting /
// rejected / revenue, used for the RESULTS line chart (per sim-minute).
function testSnapshot() {
  const done = orders.filter((o) => o.status === 'completed');
  const created = orders.length;
  const accepted = orders.filter((o) => o.driverId || (o.taxis || []).length).length;
  const waiting = orders.filter((o) => o.status === 'waiting').length;
  const canceled = orders.filter((o) => o.status === 'canceled').length;
  const declines = drivers.reduce((s, d) => s + d.declines.length, 0);
  const revenue = done.reduce((s, o) => s + (o.lockedFare ?? o.fare), 0);
  return { t: Math.round(simClock.value), created, accepted, waiting, rejected: canceled + declines, revenue: Math.round(revenue * 10) / 10 };
}

// ---------- sim tick ----------
let timer = null;
// The tick clock always runs the fleet locally (sync). All R1/bridge work is
// launched fire-and-forget so a slow OSRM auction can NEVER freeze movement.
let auctionBusy = false;
let lastTickAt = 0; // wall-clock anchor for the REAL sim timer
let lastSeriesMin = 0; // last sim-minute recorded into runSeries
async function tick() {
  if (!running.value || inFlight) return;
  // Real-time sim clock: dt is the actual wall-clock elapsed since the last
  // tick (clamped to 2 s so a slow auction or a long pause only causes a
  // bounded jump), multiplied by the speed toggle. Paused → the clock stalls.
  const nowMs = performance.now();
  const dtReal = lastTickAt ? Math.min((nowMs - lastTickAt) / 1000, 2) : 0.6;
  lastTickAt = nowMs;
  inFlight = true;
  try {
    tickCount.value++;
    const dtSim = Math.max(0.05, dtReal) * speed.value;
    simClock.value += dtSim;
    const waitingNow = [];
    for (const o of orders) {
      if (o.status !== 'waiting') continue;
      o.ageSec = (o.ageSec || 0) + dtSim;
      waitingNow.push(o);
      if (o.ageSec > MAX_WAIT_SEC) {
        o.status = 'canceled'; o.state = 'canceled';
        pushFeed(`✕ ${o.id} auto-canceled after ${fmtAge(o.ageSec)} with no taxi`, 'warn');
      }
    }
    if (liveTraffic.value) {
      // Live demand cadence: SLOWER during a test (taxis run at ×3-5, so the
      // street stays readable); the pool cap also drops so riders get served.
      const liveEvery = testCfg.active ? 25 : 5;
      const liveCap = testCfg.active ? 8 : 25;
      if (tickCount.value % liveEvery === 0 && waitingNow.length < liveCap) {
        const o = liveHail();
        pushFeed(`Live demand: new ${o.service === 'petit_taxi' ? '🐟 in-zone ' : ''}${o.private ? '🔒 private ' : ''}${o.priority ? `prio${o.priority} ` : ''}${o.passengers > 1 ? `group(${o.passengers}) ` : ''}${o.bags ? `🧳${o.bags} ` : ''}order ${o.id} hailed ${o.pickupLabel}`, 'info');
      }
    }
    // Movement is app-owned and synchronous — it never waits on R1.
    moveDrivers(dtSim);
    renderMap();
    // Intelligence is decoupled from the tick clock.
    if (bridgeDown.value) {
      // Bridge down: keep the map alive locally, retry health quietly.
      if (tickCount.value % 10 === 0) R1.health().then(noteBridgeOk).catch(() => {});
    } else {
      // Keep the best roads available: retry OSRM every ~60s when on mock,
      // fall back when it dies. Quiet — checkRoads only notes transitions.
      if (tickCount.value % 100 === 0) checkRoads(true).catch(() => {});
      if (!auctionBusy && tickCount.value % 2 === 0) {
        auctionBusy = true;
        auctionTick().catch(() => {}).finally(() => { auctionBusy = false; });
      }
    }
    // Sample the running stats every sim-minute for the RESULTS line chart.
    if (testCfg.active && simClock.value >= lastSeriesMin * 60 + 60) {
      lastSeriesMin = Math.floor(simClock.value / 60);
      runSeries.push(testSnapshot());
    }
    if (testCfg.active && simClock.value >= testCfg.endAt) finishTest();
  } finally { inFlight = false; }
}

// NEW TEST = the setup wizard: ask the city name → draw the Petit zone edges
// → configure the fleet → generate demand → start. Reset first so the run is
// fresh, exactly like the old TEST SETUP modal but always zone-driven.
function newTest() {
  reset();
  showSetup.value = false;
  showResults.value = false;
  wizard.open = true;
  wizard.step = 'name';
  wizard.name = '';
  wizard.fleetType = 'petit';
  wizard.fleetCount = 4;
  pushFeed('🧪 NEW TEST — name the city, draw the Petit zone edges, configure the fleet, then start. Orders stay in-zone; petits never leave the edges.', 'info');
}

async function startTest() {
  setPricing({ rate: +testForm.rate, base: +testForm.base, mode: testForm.mode, night: testForm.night, bags: testForm.bags, bagsFee: +testForm.bagsFee });
  const city = setCity(testForm.city);
  const cc = cities.value.find((x) => x.city_name === testForm.city);
  if (cc) activeCityId.value = cc.city_id;
  if (wizard.name) { testForm.city = wizard.name; wizard.name = ''; } // keep the wizard-created city aligned
  reset();
  // Centre on the ACTIVE city's zone centroid (the setCity geo copy is stale —
  // the zone commit updates only the RT city), so grands spawn on the zone too.
  const view = (cc && cc.center) || city.center;
  map.setView(view, 13);
  await buildBaseGrid();
  renderArea();
  const petit = Math.max(0, Math.min(50, +testForm.petit || 0));
  const grand = Math.max(0, Math.min(50, +testForm.grand || 0));
  if (petit + grand === 0) { pushFeed('Add at least one taxi (petit or grand) to run the test', 'warn'); return; }
  placeFleet(petit, 'petit');
  placeFleet(grand, 'grand');
  // Random in-zone orders hail while it runs; seed a first wave right away.
  const seedCount = Math.max(6, Math.round((petit + grand) * 1.5));
  for (let i = 0; i < seedCount; i++) liveHail(testForm.priority && i < 4 ? i : undefined); // PRIORITY #1 → the first wave always covers tiers 0-3
  runSeries = [];
  lastSeriesMin = 0;
  liveTraffic.value = testForm.live;
  testCfg.active = true; testCfg.city = testForm.city;
  simClock.value = 0; testCfg.endAt = +testForm.duration;
  speed.value = +testForm.speed || 5; // taxis move ×5 during a test; DISPATCH SPEED still adjusts live
  running.value = true; showSetup.value = false; wizard.open = false; showResults.value = false;
  pushFeed(`TEST on R1 core: ${testForm.city} · ${fmtAge(+testForm.duration)} · ${petit}🚕 + ${grand}🚐 taxis · ${testForm.rate} MAD/km · ×${speed.value} speed${testForm.priority ? ' · PRIO 0-3' : ''}${testForm.live ? ' · live orders' : ''}`, 'ok');
}
function finishTest() {
  testCfg.active = false; running.value = false;
  runSeries.push(testSnapshot()); // last point always lands inside the chart
  const done = orders.filter((o) => o.status === 'completed');
  const canceled = orders.filter((o) => o.status === 'canceled').length;
  const accepted = orders.filter((o) => o.driverId || (o.taxis || []).length).length;
  const active = orders.filter((o) => o.status === 'waiting' || o.status === 'riding' || o.status === 'assigned').length;
  const created = orders.length;
  const declines = drivers.reduce((s, d) => s + d.declines.length, 0);
  const revenue = done.reduce((s, o) => s + (o.lockedFare ?? o.fare), 0);
  const avgFare = done.length ? revenue / done.length : 0;
  const waits = done.map((o) => o.waitSec ?? o.ageSec ?? 0);
  const avgWait = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;
  results.value = {
    city: testCfg.city, simTime: fmtAge(simClock.value), taxis: drivers.length,
    total: orders.length, created, accepted, waiting: orders.filter((o) => o.status === 'waiting').length,
    completed: done.length, canceled, rejected: canceled + declines, active,
    completionPct: orders.length ? Math.round((done.length / orders.length) * 100) : 0,
    revenue: Math.round(revenue * 10) / 10,
    avgFare: Math.round(avgFare * 10) / 10, avgWait: Math.round(avgWait),
    declines, tariff: `price = km × ${pricing.rate} + ${pricing.base} base${pricing.mode === 'private' ? ` × ${pricing.privateMult} private` : ''}${pricing.night ? ` × ${pricing.nightMult} night` : ''}${pricing.bags ? ` + ${pricing.bagsFee} bags` : ''}`,
    rides: [...done].sort((a, b) => (b.lockedFare ?? b.fare) - (a.lockedFare ?? a.fare)),
    series: runSeries.slice(),
  };
  showResults.value = true;
  pushFeed(`TEST finished — ${done.length}/${orders.length} completed · ${accepted} accepted · ${results.value.rejected} rejected · revenue ${results.value.revenue} MAD`, 'ok');
}
function orderStatusLabel(id) {
  const o = orders.find((x) => x.id === id);
  if (!o) return '→ still in pool';
  if (o.status === 'canceled') return '→ order auto-canceled';
  return o.driverId ? `→ R1 assigned to ${o.driverId}` : '→ still in R1 pool';
}
async function stepOnce() {
  const was = running.value;
  running.value = true; await tick(); running.value = was;
}

const stats = computed(() => ({
  taxis: drivers.length,
  waiting: orders.filter((o) => o.status === 'waiting').length,
  riding: orders.filter((o) => o.status === 'riding' || o.status === 'assigned').length,
  done: orders.filter((o) => o.status === 'completed').length,
  canceled: orders.filter((o) => o.status === 'canceled').length,
  revenue: Math.round(orders.filter((o) => o.status === 'completed').reduce((s, o) => s + (o.lockedFare ?? o.fare), 0) * 10) / 10,
  declines: drivers.reduce((s, d) => s + d.declines.length, 0),
  testLeft: testCfg.active ? fmtAge(Math.max(0, testCfg.endAt - simClock.value)) : null,
}));
const selRemaining = computed(() => (sel.value ? Math.round(remainingOnRoute(sel.value.pos, sel.value.routeGeometry, sel.value.routeIdx)) : 0));
const selRadar = computed(() => {
  if (!sel.value?.corridor?.length) return [];
  return orders.filter((o) => o.status === 'waiting' && inCorridorCells(sel.value.corridor, o.pickup.lat, o.pickup.lng));
});
// Newest orders first: the freshly created/last orders sit at the top of the
// scrollable ledger, always visible. Older orders sink below the fold.
const recentOrders = computed(() => orders.slice().reverse());

onMounted(async () => {
  initMap();
  renderArea();
  if (typeof window !== 'undefined') { // dev verification surface (read-only snapshots)
    window.__r1Debug = {
      orders: () => orders.map((o) => ({ id: o.id, service: o.service, status: o.status, pickup: o.pickup, dropoff: o.dropoff, pickupCell: o.pickupCell, dropoffCell: o.dropoffCell, driverId: o.driverId, fare: o.fare, oid: o.oid ?? null, lvl: o.lvl ?? null, priority: o.priority ?? null, passengers: o.passengers ?? null, bags: o.bags ?? null, private: o.private ?? null, probe: o.probe ?? null })),
      active: () => (active.value ? { city_id: active.value.city_id, city_name: active.value.city_name, services: { ...active.value.services }, prestaId: active.value.prestaId ?? null, area: areaCells(active.value, 'petit_taxi') } : null),
      zone: () => (active.value ? areaCells(active.value, 'petit_taxi') : []),
      wizard: () => ({ ...wizard }),
      drivers: () => drivers.map((d) => ({ id: d.id, type: d.type, pos: d.pos, seats: d.seats })),
      cities: () => cities.value.map((c) => ({ city_id: c.city_id, city_name: c.city_name, active: c === active.value })),
      running: () => running.value,
      simClock: () => simClock.value,
      speed: () => speed.value,
      testCfg: () => ({ ...testCfg }),
      testForm: () => ({ ...testForm }),
      runSeries: () => runSeries.map((p) => ({ ...p })),
      results: () => { const r = results.value; if (!r) return null; return { ...r, rides: (r.rides || []).map((x) => ({ id: x.id, fare: x.lockedFare ?? x.fare, pickupLabel: x.pickupLabel, dropoffLabel: x.dropoffLabel, directKm: x.directKm, waitSec: x.waitSec ?? x.ageSec ?? 0 })) }; },
      showResults: () => showResults.value,
      finishNow: () => { finishTest(); },
      editing: () => editing.value,
      feed: () => feed.value.map((f) => f.msg ?? f.text),
      editor: () => (editor.value ? { mode: editor.value.mode, verts: editor.value.verts.length, polys: editor.value.polys.length, cells: editor.value.cells.size, excluded: editor.value.excluded.size } : null),
      h3CellOf,
      confinedPoint,
      zoneGeo,
      ptInZone,
      // Deterministically exercises the real marker drag-end handler (snap-to-zone).
      dragTaxi: (id, lat, lng) => {
        const m = layers.drivers.get(id);
        if (!m) return false;
        m.setLatLng([lat, lng]);
        m.fire('dragend');
        return true;
      },
      setupModal: () => { showSetup.value = true; },
    };
  }
  try {
    const h = await R1.health();
    r1ok.value = true; noteBridgeOk();
    pushFeed(`R1 core connected (${R1_BASE}) — all routing/matching by ${h.engine}`, 'ok');
  } catch (e) {
    r1ok.value = false;
    bridgeFails = 1; noteBridgeError(e); // banner immediately; skips pre-detection fetches
    if (!bridgeDown.value) pushFeed('R1 engine unavailable — run: npm run r1:build, then reload', 'warn');
  }
  await checkRoads(true); // best roads available before first pricing
  // No seeded traffic: the SETUP wizard asks for the city name, then the
  // operating zone, then the fleet. Nothing runs until the admin completes it.
  running.value = false;
  timer = setInterval(() => { tick(); }, 600);
});
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <div class="h-screen w-screen bg-black text-white flex flex-col overflow-hidden font-sans">
    <!-- header -->
    <header class="flex items-center justify-between px-4 py-2 border-b border-white/20 bg-black/90 backdrop-blur z-20">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg bg-white text-black font-black flex items-center justify-center text-sm shadow-[0_0_18px_rgba(255,255,255,0.35)]">R1</div>
        <div>
          <h1 class="font-black tracking-[0.12em] text-sm leading-none">R1 · RYDAT INTELLIGENT MATCHING</h1>
          <p class="font-mono text-[10px] text-[#888] mt-0.5">POWERED BY R1 CORE (C++) · H3 gridDisk=2 · detour≤1.3x · priority 0-3 · passengers/bags</p>
        </div>
      </div>
      <div class="hidden lg:flex items-center gap-2 font-mono text-[11px]">
        <span v-if="stats.testLeft" class="text-black bg-white rounded-full px-3 py-0.5 font-black">⏱ {{ stats.testLeft }}</span>
        <span class="border border-white/25 rounded-full px-2.5 py-0.5">TAXIS <b class="text-white">{{ stats.taxis }}</b></span>
        <span class="border border-white/25 rounded-full px-2.5 py-0.5">WAIT {{ stats.waiting }}</span>
        <span class="border border-white/25 rounded-full px-2.5 py-0.5">RIDE {{ stats.riding }}</span>
        <span class="border border-white/25 rounded-full px-2.5 py-0.5">DONE {{ stats.done }}</span>
        <span class="border border-red-500/60 text-red-400 rounded-full px-2.5 py-0.5">✕ {{ stats.canceled }}</span>
        <span class="border border-green-500/60 text-green-400 rounded-full px-2.5 py-0.5">{{ stats.revenue }} MAD</span>
      </div>
    </header>
    <div v-if="bridgeDown" class="z-30 bg-red-600 text-white font-mono text-[11px] px-4 py-1.5 text-center">
      R1 ENGINE UNAVAILABLE — matching paused. Run <b>npm run r1:build</b>, then reload.
    </div>

    <div class="flex flex-1 min-h-0 relative">
      <!-- map -->
      <div class="flex-1 relative min-w-0">
        <div ref="mapEl" class="absolute inset-0 z-0"></div>
        <!-- controls overlay -->
        <div class="absolute top-3 left-3 z-10 bg-black/85 backdrop-blur rounded-xl border border-white/25 shadow-[0_8px_30px_rgba(0,0,0,0.7)] p-3 w-[252px] space-y-2.5">
          <p class="font-black text-[11px] tracking-[0.2em] text-[#aaa]">DISPATCH</p>
          <p class="font-mono text-[10px]" :class="r1ok ? 'text-green-400' : 'text-red-400'">{{ r1ok ? '● R1 CORE CONNECTED' : '○ R1 BRIDGE OFFLINE' }}</p>
          <div class="grid grid-cols-3 gap-1.5">
            <button @click="running = true" :class="running ? 'bg-white text-black' : 'bg-white/5 text-white'" class="rounded-lg border border-white/40 font-black text-xs py-1.5 transition-colors hover:border-white">▶ START</button>
            <button @click="running = false" :class="!running ? 'bg-white text-black' : 'bg-white/5 text-white'" class="rounded-lg border border-white/40 font-black text-xs py-1.5 transition-colors hover:border-white">⏸ PAUSE</button>
            <button @click="stepOnce" class="rounded-lg border border-white/40 font-black text-xs py-1.5 bg-white/5 transition-colors hover:bg-white hover:text-black">STEP ▸</button>
          </div>
          <button @click="reset" class="w-full rounded-lg border border-white/25 font-mono text-[11px] py-1.5 text-[#aaa] transition-colors hover:bg-white hover:text-black">↺ RESET</button>
          <div>
            <p class="font-mono text-[10px] tracking-[0.18em] text-[#888] mb-1">SPEED</p>
            <div class="grid grid-cols-3 gap-1.5 p-1 rounded-lg bg-white/5 border border-white/15">
              <button v-for="s in [1, 2, 5]" :key="s" @click="speed = s" :class="speed === s ? 'bg-white text-black shadow' : 'text-[#aaa]'" class="rounded-md font-mono text-xs py-1 transition-colors">{{ s }}x</button>
            </div>
          </div>
          <div class="grid grid-cols-1 gap-1.5">
            <button @click="spawnTraffic(4, 8)" class="rounded-lg border border-white/40 font-black text-xs py-2 transition-colors hover:bg-white hover:text-black">＋ RANDOM TRAFFIC</button>
            <button @click="spawnScenario4" class="rounded-lg border border-white/40 font-black text-xs py-2 transition-colors hover:bg-white hover:text-black">◆ SCENARIO USER 4</button>
            <button @click="newTest" class="rounded-lg bg-white text-black font-black text-xs py-2 transition-colors hover:bg-[#bbb]">🧪 NEW TEST</button>
            <button @click="addEdgeProbes(3)" :disabled="!activeAreaInfo.petitCells" class="rounded-lg border border-amber-400/50 text-amber-300 font-black text-xs py-2 transition-colors hover:bg-amber-400 hover:text-black disabled:opacity-30">⛺ EDGE PROBES</button>
            <button @click="showCityConfig = true" class="rounded-lg border border-sky-400/50 text-sky-300 font-black text-xs py-2 transition-colors hover:bg-sky-400 hover:text-black">🏙 CITY & ZONES{{ activeAreaInfo.petitCells ? ` · ${activeAreaInfo.petitCells}🐟` : '' }}</button>
            <button @click="showResults = true" :disabled="!results" class="rounded-lg border border-white/40 font-black text-xs py-2 transition-colors hover:bg-white hover:text-black disabled:opacity-30">📊 RESULTS{{ results ? ` · ${results.revenue}` : '' }}</button>
          </div>
          <label class="flex items-center gap-2 font-mono text-[10px] text-[#888] cursor-pointer">
            <input type="checkbox" v-model="showAllCorridors" @change="renderMap" class="accent-white" /> SHOW HEXAGON CORRIDORS (0.1 km²)
          </label>
          <label class="flex items-center gap-2 font-mono text-[10px] text-[#888] cursor-pointer">
            <input type="checkbox" v-model="showHeat" @change="renderMap" class="accent-white" /> DEMAND HEATMAP (RED = HOT)
          </label>
          <label class="flex items-center gap-2 font-mono text-[10px] text-[#888] cursor-pointer">
            <input type="checkbox" v-model="liveTraffic" class="accent-white" /> LIVE ORDERS WHILE PLAYING
          </label>
          <div class="font-mono text-[10px] text-[#888] leading-relaxed border-t border-white/30 pt-2">
            <p>🚕 taxi (drag me) · 🧍 pickup (drag, click = 🏁 destination + road path)</p>
            <p>🏁 current destination · 🏴 queued dropoff (multi-order taxis)</p>
            <p>🔥 heat order (&gt;5min wait) — nearest taxi forced to accept</p>
            <p><span class="text-[#888]">⬡</span> hex grid 0.1 km² always on · corridor = decider gridDisk(2)</p>
            <p><span class="text-sky-400">⬡</span> sky hexes = Petit operating area · 🐟/🚐 generated orders</p>
            <p>black solid = R1 road route (reroutes on every accept) · <span class="text-red-400">■</span> heat = order density · <span class="text-red-400">- -</span> declined</p>
            <p>Drag taxis + orders anywhere. Click an order dot to edit From/To.</p>
          </div>
        </div>
        <!-- H3 operating-area editor -->
        <div v-if="editing" class="absolute top-[52px] right-3 z-30 bg-black/90 backdrop-blur rounded-xl border border-sky-400/60 shadow-[0_8px_30px_rgba(0,0,0,0.7)] p-2.5 w-[300px] space-y-1.5">
          <div class="flex items-center justify-between">
            <p class="font-black text-[11px] tracking-[0.18em] text-sky-300">⬡ OPERATING AREA · PETIT</p>
            <button @click="cancelEditArea" class="border border-white/40 text-[#aaa] font-black text-[10px] px-2 py-0.5 hover:bg-white hover:text-black">✕</button>
          </div>
          <div class="grid grid-cols-2 gap-1.5 font-mono text-[10px]">
            <button @click="switchEditorMode('edges')" :class="editor?.mode === 'edges' ? 'bg-cyan-400 text-black shadow' : 'border border-white/40'" class="rounded-lg font-black py-1.5 hover:border-cyan-300">▰ ZONE EDGES</button>
            <button @click="switchEditorMode('cells')" :class="editor?.mode === 'cells' ? 'bg-sky-400 text-black shadow' : 'border border-white/40'" class="rounded-lg font-black py-1.5 hover:border-sky-300">⬡ HEX CELLS</button>
          </div>
          <p class="font-mono text-[10px] text-[#aaa] leading-snug">{{ editor?.mode === 'edges'
            ? 'Click the outline to extend the zone — the surface auto-fills with hexes right away. Click INSIDE a hex to remove just that one. Two blobs are linked by an auto hex-corridor.'
            : `Pickup zone for ${active.city_name} petits. Click map hexes to select/deselect.` }}</p>
          <div v-if="editor?.mode === 'edges'" class="grid grid-cols-2 gap-1.5 font-mono text-[10px]">
            <button @click="keepBlob" :disabled="!(editor && editor.verts.length >= 3)" class="rounded-lg border border-cyan-400/60 text-cyan-300 font-black py-1.5 hover:bg-cyan-400 hover:text-black disabled:opacity-30">🔒 LOCK BLOB</button>
            <button @click="deleteLastVertex" class="rounded-lg border border-white/40 font-black py-1.5 hover:bg-white hover:text-black">⌫ UNDO VERTEX</button>
            <button @click="clearEditorEdges" class="rounded-lg border border-white/40 font-black py-1.5 hover:bg-white hover:text-black">✕ CLEAR ALL</button>
          </div>
          <div v-else class="grid grid-cols-2 gap-1.5 font-mono text-[10px]">
            <button @click="deleteLastEditorCell" class="rounded-lg border border-white/40 font-black py-1.5 hover:bg-white hover:text-black">⌫ DELETE LAST</button>
            <button @click="clearEditorCells" class="rounded-lg border border-white/40 font-black py-1.5 hover:bg-white hover:text-black">✕ CLEAR</button>
          </div>
          <div class="flex items-center justify-between font-mono text-[10px] text-[#888] border-t border-white/15 pt-1.5">
            <span>{{ editor ? editor.cells.size : 0 }} HEXAGONS · {{ editor && editor.polys.length }} blob{{ editor && editor.polys.length === 1 ? '' : 's' }} · res {{ H3_RES }}</span>
            <span class="text-[#555]">{{ editor?.mode === 'edges' ? '~0.1 km²' : 'fine edit' }}</span>
          </div>
          <div class="grid grid-cols-2 gap-1.5 font-mono text-[10px]">
            <button @click="saveArea" :disabled="!editing || !(editor && editor.cells.size > 0)" class="rounded-lg bg-sky-400 text-black font-black py-2 hover:bg-sky-300 disabled:opacity-30">✓ {{ editor?.mode === 'edges' ? 'DONE' : 'SAVE' }}</button>
            <button @click="cancelEditArea" class="rounded-lg border border-white/40 font-black py-2 hover:bg-white hover:text-black">CANCEL</button>
          </div>
        </div>
        <!-- event ticker -->
        <div class="absolute bottom-3 left-3 z-10 bg-black/85 backdrop-blur rounded-xl border border-white/25 shadow-[0_8px_30px_rgba(0,0,0,0.7)] w-[400px] max-w-[60vw] overflow-hidden">
          <p class="font-black text-[10px] tracking-[0.2em] text-[#aaa] px-3 py-1.5 border-b border-white/15">LIVE MATCHING FEED</p>
          <div class="max-h-28 overflow-y-auto font-mono text-[10px] px-3 py-1.5 space-y-1">
            <p v-for="(e, i) in feed.slice(0, 20)" :key="i" :class="e.kind === 'warn' ? 'text-red-400' : e.kind === 'ok' ? 'text-green-400' : 'text-[#888]'">[{{ e.at }}] {{ e.msg }}</p>
          </div>
        </div>
      </div>

      <!-- inspector sidebar -->
      <aside class="w-[370px] shrink-0 border-l border-white/20 bg-[#0d0d0d] flex flex-col min-h-0 z-20 overflow-y-auto">
        <div class="p-3 border-b border-white/15">
          <p class="font-black text-[11px] tracking-[0.18em] text-[#aaa] mb-2">FLEET · {{ drivers.length }} TAXIS</p>
          <div class="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto mb-2">
            <button v-for="d in drivers" :key="d.id" @click="selectDriver(d.id, true)" :class="d.id === selectedId ? 'bg-white text-black border-white' : 'bg-white/5 text-white border-white/25'" class="rounded-full border font-mono text-[11px] pl-2 pr-2.5 py-1 transition-colors hover:border-white"><span :class="d.privateRide ? 'text-fuchsia-400' : (d.seats > 0 ? 'text-amber-400' : 'text-green-400')">●</span> <span :class="d.type === 'grand' ? 'text-sky-300' : ''">{{ d.id.split('T')[1] ? d.id : d.id }}</span> <span :title="d.type">{{ d.type === 'grand' ? '🚐' : '🚕' }}</span> [{{ d.seats }}/{{ d.passengerCapacity || d.capacity }}]{{ d.privateRide ? ' 🔒' : '' }}{{ d.bags ? ` 🧳${d.bags}` : '' }}{{ d.deciderId ? ' ★' : '' }}</button>
          </div>
          <div class="grid grid-cols-3 gap-1.5">
            <select v-model="taxiType" class="rounded-lg border border-white/40 bg-black font-black text-[10px] px-1 py-1 text-center transition-colors">
              <option value="petit">🚕 PETIT</option>
              <option value="grand">🚐 GRAND</option>
            </select>
            <button @click="addTaxi()" class="rounded-lg border border-white/40 font-black text-xs py-1.5 transition-colors hover:bg-white hover:text-black">＋ ADD</button>
            <button @click="removeSelectedTaxi" :disabled="!selectedId" class="rounded-lg border border-white/40 font-black text-xs py-1.5 transition-colors hover:bg-white hover:text-black disabled:opacity-30">− REMOVE</button>
          </div>
          <label class="flex items-center gap-2 font-mono text-[10px] text-[#888] cursor-pointer mt-2">
            <input type="checkbox" v-model="follow" class="accent-white" /> FOLLOW SELECTED TAXI IN PLAY MODE
          </label>
        </div>

        <div class="p-3 border-b border-white/15">
          <div class="flex items-center justify-between mb-2">
            <p class="font-black text-[11px] tracking-[0.18em] text-[#aaa]">ORDERS · {{ orders.length }}</p>
            <div class="flex gap-1.5">
              <button @click="addOrder" class="rounded-lg border border-white/40 font-black text-[11px] px-2.5 py-1 transition-colors hover:bg-white hover:text-black">＋ ADD</button>
              <button @click="deleteOrder" :disabled="!selectedOrderId" class="rounded-lg border border-white/40 font-black text-[11px] px-2.5 py-1 transition-colors hover:bg-white hover:text-black disabled:opacity-30">− DEL</button>
            </div>
          </div>
          <div v-if="selOrder" class="rounded-lg border border-white/25 bg-white/5 p-2 font-mono text-[11px] space-y-1 mb-2">
            <p class="font-black font-sans text-xs" :style="{ color: orderColor(selOrder) }">{{ selOrder.id }} · {{ selOrder.status }} · {{ selOrder.state }}</p>
            <p class="text-[#888]">FROM (pickup — drag P or type)</p>
            <div class="grid grid-cols-2 gap-1">
              <input v-model.number="selOrder.pickup.lat" @change="onOrderMoved(selOrder, 'pickup')" type="number" step="0.0001" class="bg-black border border-white px-1 py-0.5 w-full" />
              <input v-model.number="selOrder.pickup.lng" @change="onOrderMoved(selOrder, 'pickup')" type="number" step="0.0001" class="bg-black border border-white px-1 py-0.5 w-full" />
            </div>
            <p class="text-[#888]">TO (dropoff — drag D or type)</p>
            <div class="grid grid-cols-2 gap-1">
              <input v-model.number="selOrder.dropoff.lat" @change="onOrderMoved(selOrder, 'dropoff')" type="number" step="0.0001" class="bg-black border border-white px-1 py-0.5 w-full" />
              <input v-model.number="selOrder.dropoff.lng" @change="onOrderMoved(selOrder, 'dropoff')" type="number" step="0.0001" class="bg-black border border-white px-1 py-0.5 w-full" />
            </div>
            <div class="grid grid-cols-4 gap-1 mt-1">
              <label class="text-[10px] text-[#aaa]">
                PAX
                <input v-model.number="selOrder.passengers" type="number" min="1" step="1" class="bg-black border border-white px-1 py-0.5 w-full text-white font-mono" />
              </label>
              <label class="text-[10px] text-[#aaa]">
                BAGS
                <input v-model.number="selOrder.bags" type="number" min="0" step="1" class="bg-black border border-white px-1 py-0.5 w-full text-white font-mono" />
              </label>
              <label class="text-[10px] text-[#aaa]">
                PRIO
                <select v-model.number="selOrder.priority" class="bg-black border border-white px-1 py-0.5 w-full text-white font-mono">
                  <option :value="0">0 normal</option>
                  <option :value="1">1 high</option>
                  <option :value="2">2 urgent</option>
                  <option :value="3">3 emergency</option>
                </select>
              </label>
              <label class="flex items-center justify-center text-[10px] text-[#aaa]">
                <input type="checkbox" v-model="selOrder.private" class="accent-white" /> 🔒
              </label>
            </div>
            <p class="text-[#888]">fare {{ selOrder.lockedFare ?? selOrder.fare }} MAD · driver {{ selOrder.driverId || '—' }} · {{ selOrder.pickupLabel }}</p>
            <p class="text-[#888]">road path: {{ selOrder.osrm === 'ok' ? '🛣️ R1 road ✓' : selOrder.osrm === 'loading' ? 'R1 routing…' : selOrder.osrm === 'fail' ? 'R1 unreachable' : 'click icon to load' }}
              <button @click="loadOrderPath(selOrder)" class="border border-white px-1 ml-1 hover:bg-white hover:text-black">RETRY</button>
            </p>
          </div>
          <p v-else class="font-mono text-[11px] text-[#888] mb-2">Click any row or map icon to see From → To + real road path.</p>
          <!-- ALL ORDERS MENU — newest first, so the last orders stay visible -->
          <div class="max-h-44 overflow-y-auto space-y-1 font-mono text-[10px]">
            <button v-for="o in recentOrders" :key="o.id" @click="selectOrder(o.id, true)"
              :class="o.id === selectedOrderId ? 'bg-white !text-black border-white' : 'bg-white/5 border-white/15'"
              :style="(o.status === 'waiting' && (o.ageSec || 0) >= HEAT_SEC && o.id !== selectedOrderId) ? 'border-color:#ef4444;' : ''"
              class="w-full text-left rounded-lg border px-2 py-1 transition-colors hover:border-white">
              <span class="font-black" :style="o.id === selectedOrderId ? '' : { color: (o.status === 'waiting' && (o.ageSec || 0) >= HEAT_SEC) ? '#ef4444' : orderColor(o) }">{{ (o.status === 'waiting' && (o.ageSec || 0) >= HEAT_SEC) ? '🔥' : '🧍' }} {{ o.id }}{{ o.service === 'petit_taxi' ? '🐟' : o.service === 'grand_taxi' ? '🚐' : '' }}</span>
              <span :class="o.id === selectedOrderId ? 'text-black' : 'text-[#aaa]'"> · {{ o.status }}{{ o.status === 'waiting' ? ` · ⏱${fmtAge(o.ageSec || 0)}${(o.ageSec || 0) >= HEAT_SEC ? ' HEAT' : ''}` : '' }}</span>
              <span :class="o.id === selectedOrderId ? 'text-black' : 'text-[#aaa]'"> · 👥{{ o.passengers }}{{ (o.served||0) < o.passengers ? `(${o.served||0}/${o.passengers})` : '' }}{{ (o.bags || 0) ? `·🧳${o.bags}` : '' }}{{ o.priority ? `·PRIO${o.priority}` : '' }}{{ o.private ? '·🔒' : '' }}{{ (o.taxis||[]).length > 1 ? `·T${o.taxis.length}` : '' }}</span><br />
              <span :class="o.id === selectedOrderId ? 'text-black' : 'text-[#888]'">FROM {{ o.pickup.lat.toFixed(4) }},{{ o.pickup.lng.toFixed(4) }} → TO {{ o.dropoff.lat.toFixed(4) }},{{ o.dropoff.lng.toFixed(4) }} · {{ o.lockedFare ?? o.fare }} MAD{{ o.driverId ? ` · ${o.driverId}` : '' }}</span>
            </button>
            <p v-if="!orders.length" class="text-[#888]">No orders — press ＋ ADD or enable LIVE ORDERS.</p>
          </div>
        </div>

        <div v-if="sel" class="p-3 space-y-2.5 font-mono text-[11px]">
          <div class="rounded-lg border border-white/25 bg-white/5 p-2.5">
            <p class="font-black text-xs font-sans">● {{ sel.id }} {{ sel.available ? '· AVAILABLE' : '· BUSY' }} {{ sel.deciderId ? '· DECIDER ' + sel.deciderId : '' }}</p>
            <p class="text-[#888]">{{ sel.pos.lat.toFixed(5) }}, {{ sel.pos.lng.toFixed(5) }} · hdg {{ sel.heading.toFixed(0) }}° · rem {{ selRemaining }}m · corridor {{ sel.corridor.size }} hex</p>
          </div>
          <div class="rounded-lg border border-white/25 bg-white/5 p-2.5">
            <p class="font-black text-xs font-sans mb-1">VEHICLE CAPACITY</p>
            <div class="grid grid-cols-4 gap-1 text-center">
              <label class="text-[9px] text-[#aaa] flex flex-col">
                SEATS
                <input v-model.number="sel.passengerCapacity" type="number" min="0" step="1" class="bg-black border border-white px-1 py-0.5 w-full text-white text-center font-mono" />
              </label>
              <label class="text-[9px] text-[#aaa] flex flex-col">
                BAGS
                <input v-model.number="sel.bagCapacity" type="number" min="0" step="1" class="bg-black border border-white px-1 py-0.5 w-full text-white text-center font-mono" />
              </label>
              <label class="text-[9px] text-[#aaa] flex flex-col">
                ONBD
                <span class="border border-white/25 px-1 py-0.5 w-full text-center text-amber-400 font-mono">{{ sel.seats }}/{{ sel.passengerCapacity || '∞' }}</span>
              </label>
              <label class="text-[9px] text-[#aaa] flex flex-col">
                BAGS
                <span class="border border-white/25 px-1 py-0.5 w-full text-center text-amber-400 font-mono">{{ sel.bags }}/{{ sel.bagCapacity || '∞' }}</span>
              </label>
            </div>
            <p class="text-[9px] text-[#888] mt-1">{{ sel.privateRide ? '🔒 PRIVATE RIDE ACTIVE' : 'SHARED — R1 pools by capacity & detour' }} · cap {{ sel.capacity }} (legacy)</p>
          </div>
          <div class="rounded-lg border border-white/25 bg-white/5 p-2.5">
            <p class="font-black text-xs font-sans mb-1">RADAR — COMPATIBLE ORDERS IN CORRIDOR ({{ selRadar.length }})</p>
            <p v-if="!selRadar.length" class="text-[#888]">No compatible orders in corridor.</p>
            <p v-for="o in selRadar" :key="o.id" :style="{ color: orderColor(o) }">{{ o.id }} {{ o.pickup.lat.toFixed(4) }},{{ o.pickup.lng.toFixed(4) }} → fare {{ o.fare }} MAD</p>
          </div>
          <div class="rounded-lg border border-white/25 bg-white/5 p-2.5">
            <p class="font-black text-xs font-sans mb-1">MATCHED BOOKINGS ({{ sel.bookings.length }})</p>
            <div v-for="b in sel.bookings" :key="b.orderId" class="border-t border-white/15 py-1">
              <p>{{ b.decider ? '★ DECIDER' : '◇ POOLED' }} {{ b.orderId }} · {{ b.fare }} MAD {{ b.locked ? '(LOCKED)' : '' }} · {{ b.state }}</p>
              <p v-for="(ev, i) in b.events" :key="i" class="text-[#888]">[{{ ev.at }}] {{ ev.e }}</p>
            </div>
          </div>
          <div class="rounded-lg border border-red-500/40 bg-red-500/5 p-2.5">
            <p class="font-black text-xs font-sans mb-1 text-red-400">DECLINED / REDIRECTED ({{ sel.declines.length }})</p>
            <div v-for="(dcl, i) in sel.declines" :key="i" class="border-t border-white/15 py-1 text-red-300">
              <p>{{ dcl.orderId }} @ {{ dcl.at }} {{ orderStatusLabel(dcl.orderId) }}</p>
              <p class="text-[#888]">{{ dcl.reason }}</p>
            </div>
          </div>
          <div class="rounded-lg border border-white/25 bg-white/5 p-2.5">
            <p class="font-black text-xs font-sans mb-1">DRIVER LOG</p>
            <p v-for="(l, i) in sel.log.slice(0, 25)" :key="i" class="text-[#888]">{{ l }}</p>
          </div>
        </div>
        <div v-else class="p-6 font-mono text-[11px] text-[#888]">Select a taxi to inspect R1 path, accept/pickup/drop markers, declined dashes (red), radar + ledger.</div>
      </aside>
    </div>

    <!-- SETUP WIZARD -->
    <div v-if="wizard.open" class="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div class="r1pop bg-[#111] border border-white/30 rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.8)] w-[470px] max-w-full max-h-full overflow-y-auto p-5 space-y-3">

        <template v-if="wizard.step === 'name'">
          <div class="flex items-center justify-between">
            <p class="font-black tracking-widest text-sm">⚙ SETUP YOUR CITY</p>
            <button @click="wizard.open = false" class="border border-white font-black text-xs px-3 py-1 hover:bg-white hover:text-black">✕</button>
          </div>
          <p class="font-black text-[10px] tracking-[0.2em] text-sky-300">STEP 1/3 · NAME</p>
          <p class="font-mono text-[10px] text-[#aaa] leading-relaxed">ZERO seeded defaults. Give your operating city a name — the map and the whole simulation spin up from it.</p>
          <label class="block font-mono text-[11px]">CITY NAME
            <input v-model="wizard.name" placeholder="e.g. Marrakech" class="w-full bg-black border border-white px-2 py-1.5 mt-1" @keyup.enter="createWizardCity" />
          </label>
          <div class="grid grid-cols-2 gap-2">
            <button @click="wizard.open = false" class="border border-white font-black text-xs py-2 hover:bg-white hover:text-black">SKIP (explore)</button>
            <button @click="createWizardCity" :disabled="!wizard.name.trim()" class="bg-white text-black font-black text-xs py-2 hover:bg-[#bbb] disabled:opacity-30">CREATE CITY →</button>
          </div>
        </template>

        <template v-else-if="wizard.step === 'zone'">
          <div class="flex items-center justify-between">
            <p class="font-black tracking-widest text-sm">⚙ SETUP · DRAW THE ZONE</p>
            <button @click="wizard.open = false" class="border border-white font-black text-xs px-3 py-1 hover:bg-white hover:text-black">✕</button>
          </div>
          <p class="font-black text-[10px] tracking-[0.2em] text-sky-300">STEP 2/3 · THE PETIT OPERATING ZONE</p>
          <p class="font-mono text-[10px] text-[#aaa] leading-relaxed">Click the map to trace the zone's outline — <b class="text-white">the surface auto-fills with hexes as you draw</b>. 🔒 LOCK BLOB between separate blobs; blobs are <b class="text-white">auto-linked into one continuous zone</b> (hex corridor). Click inside a hex to remove just that one. ✓ DONE when the shape feels right.</p>
          <p class="font-mono text-[10px] text-[#888] leading-relaxed">Petit taxis surf, haul and idle INSIDE this zone. Grand taxis roam the whole city. Draw 2–3 separate blobs to see the corridor connect them.</p>
          <button @click="editArea('edges')" class="w-full rounded-lg bg-sky-400 text-black font-black text-xs py-2 hover:bg-sky-300">✎ DRAW ZONE ON MAP →</button>
        </template>

        <template v-else>
          <div class="flex items-center justify-between">
            <p class="font-black tracking-widest text-sm">⚙ NEW TEST · CONFIG</p>
            <button @click="wizard.open = false" class="border border-white font-black text-xs px-3 py-1 hover:bg-white hover:text-black">✕</button>
          </div>
          <p class="font-black text-[10px] tracking-[0.2em] text-amber-300">STEP 3/3 · RUN THE TEST</p>
          <p class="font-mono text-[10px] text-[#aaa] leading-relaxed">🧭 CITY: <b class="text-white">{{ testForm.city }}</b> — random orders hail INSIDE the zone while the test runs; R1 matches them to the fleet. Petit taxis never leave the edges — empty or loaded.</p>
          <div class="grid grid-cols-2 gap-2 font-mono text-[11px]">
            <label>TEST TIMER (sim)
              <select v-model="testForm.duration" class="w-full bg-black border border-white px-1 py-1.5 mt-1">
                <option value="900">15 min</option>
                <option value="1800">30 min</option>
                <option value="3600">1 hour</option>
                <option value="7200">2 hours</option>
              </select>
            </label>
            <label>TAXI SPEED
              <select v-model.number="testForm.speed" class="w-full bg-black border border-white px-1 py-1.5 mt-1">
                <option :value="1">×1 real</option>
                <option :value="2">×2</option>
                <option :value="5">×5 (test default)</option>
                <option :value="10">×10</option>
              </select>
            </label>
            <label>🚕 PETIT TAXIS
              <input v-model.number="testForm.petit" type="number" min="0" max="50" class="w-full bg-black border border-white px-1 py-1.5 mt-1" />
            </label>
            <label>🚐 GRAND TAXIS
              <input v-model.number="testForm.grand" type="number" min="0" max="50" class="w-full bg-black border border-white px-1 py-1.5 mt-1" />
            </label>
            <label>PRICE / KM (MAD)
              <input v-model.number="testForm.rate" type="number" step="0.1" min="0" class="w-full bg-black border border-white px-1 py-1.5 mt-1" />
            </label>
            <label>BASE FARE (MAD)
              <input v-model.number="testForm.base" type="number" step="0.5" min="0" class="w-full bg-black border border-white px-1 py-1.5 mt-1" />
            </label>
            <label class="col-span-2 flex items-center gap-2 cursor-pointer"><input type="checkbox" v-model="testForm.night" class="accent-white" /> 🌙 NIGHT SHIFT × 1.25</label>
            <label class="col-span-2 flex items-center gap-2 cursor-pointer"><input type="checkbox" v-model="testForm.bags" class="accent-white" /> 🧳 BAGS ON +
              <input v-model.number="testForm.bagsFee" type="number" step="0.5" min="0" class="w-16 bg-black border border-white px-1 py-0.5" /> MAD</label>
            <label class="col-span-2 flex items-center gap-2 cursor-pointer"><input type="checkbox" v-model="testForm.priority" class="accent-amber-400" /> 🔀 PRIORITY RANDOM ORDERS (tiers 0-3)</label>
            <label class="col-span-2 flex items-center gap-2 cursor-pointer"><input type="checkbox" v-model="testForm.live" class="accent-sky-400" /> 📡 LIVE RANDOM ORDERS DURING TEST</label>
          </div>
          <p class="font-mono text-[10px] text-[#888]">price = km × {{ testForm.rate }} + {{ testForm.base }} base{{ testForm.mode === 'private' ? ' × 1.6 private' : '' }}{{ testForm.night ? ' × 1.25 night' : '' }}{{ testForm.bags ? ` + ${testForm.bagsFee} bags` : '' }} · taxis move at ×{{ testForm.speed }}</p>
          <button @click="runQuickTest" class="rounded-lg bg-amber-400 text-black font-black text-xs py-2 hover:bg-amber-300">⚡ QUICK TEST — 1 TAXI + 3 CONFIGS (solo · urgent+bags · private)</button>
          <div class="grid grid-cols-2 gap-2">
            <button @click="wizard.open = false" class="border border-white font-black text-xs py-2 hover:bg-white hover:text-black">CLOSE</button>
            <button @click="startTest" class="bg-white text-black font-black text-xs py-2 hover:bg-[#bbb]">▶ START TEST</button>
          </div>
        </template>

      </div>
    </div>

    <!-- CITY CONFIG + ORDER SIMULATION MODAL -->
    <div v-if="showCityConfig" class="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div class="r1pop bg-[#111] border border-white/30 rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.8)] w-[560px] max-w-full max-h-full overflow-y-auto p-5 space-y-3">
        <div class="flex items-center justify-between">
          <p class="font-black tracking-widest text-sm">🏙 CITY CONFIGURATION</p>
          <button @click="showCityConfig = false" class="border border-white font-black text-xs px-3 py-1 hover:bg-white hover:text-black">✕ CLOSE</button>
        </div>

        <div class="grid grid-cols-2 gap-2 font-mono text-[11px]">
          <label class="col-span-2">ACTIVE CITY
            <select :value="activeCityId" @change="selectCity($event.target.value)" class="w-full bg-black border border-white px-2 py-1.5 mt-1">
              <option v-for="c in cities" :key="c.city_id" :value="c.city_id">{{ c.city_name }}</option>
            </select>
          </label>
          <label class="col-span-2">NEW CITY
            <div class="flex gap-1.5 mt-1">
              <input v-model="newCityName" placeholder="e.g. Marrakech" class="flex-1 bg-black border border-white px-2 py-1.5" @keyup.enter="addCity" />
              <button @click="addCity" class="border border-white font-black text-xs px-3 py-1.5 hover:bg-white hover:text-black">＋ ADD CITY</button>
            </div>
          </label>
        </div>

        <p v-if="!active" class="rounded-xl border border-white/25 bg-white/5 p-3 font-mono text-[10px] text-[#888]">No city yet — use the <b class="text-white">SETUP wizard</b> or add one above (+ center auto-falls back to Casablanca). The draw-on-map editor needs an active city.</p>

        <!-- services -->
        <template v-if="active">
        <div class="rounded-xl border border-white/25 bg-white/5 p-3">
          <p class="font-black text-[10px] tracking-[0.2em] text-[#aaa] mb-1.5">SERVICES IN {{ active.city_name }}</p>
          <div class="grid grid-cols-2 gap-2 font-mono text-[10px]">
            <label class="flex items-center justify-between rounded-lg border border-white/20 px-2 py-1.5 transition-colors" :class="serviceEnabled(active, 'petit_taxi') ? 'border-sky-400/60' : 'opacity-50'">
              <span>🐟 Petit taxi</span>
              <input type="checkbox" :checked="serviceEnabled(active, 'petit_taxi')" @change="toggleService('petit_taxi')" class="accent-sky-400" />
            </label>
            <label class="flex items-center justify-between rounded-lg border border-white/20 px-2 py-1.5 transition-colors" :class="serviceEnabled(active, 'grand_taxi') ? 'border-amber-400/60' : 'opacity-50'">
              <span>🚐 Grand taxi</span>
              <input type="checkbox" :checked="serviceEnabled(active, 'grand_taxi')" @change="toggleService('grand_taxi')" class="accent-amber-400" />
            </label>
          </div>
          <p class="font-mono text-[10px] text-[#888] mt-1.5">{{ activeAreaInfo.summary }} · 60/40 city mix</p>
        </div>

        <!-- petit operating area -->
        <div class="rounded-xl border border-white/25 bg-white/5 p-3 space-y-2">
          <p class="font-black text-[10px] tracking-[0.2em] text-[#aaa]">H3 OPERATING AREA · PETIT PICKUPS</p>
          <p class="font-mono text-[10px] text-[#aaa] leading-snug">{{ activeAreaInfo.petitCells ? `${activeAreaInfo.petitCells} selected hexagons (res ${H3_RES} · ~0.1 km²)` : 'No area yet — petit pickups/dropoffs must be inside the drawn cells.' }}</p>
          <div class="grid grid-cols-2 gap-1.5 font-mono text-[10px]">
            <button @click="editArea()" class="rounded-lg bg-sky-400 text-black font-black py-2 hover:bg-sky-300">✎ EDIT H3 AREA ON MAP</button>
            <button @click="clearSavedArea" :disabled="!activeAreaInfo.petitCells" class="rounded-lg border border-white/40 font-black py-2 hover:bg-white hover:text-black disabled:opacity-30">✕ CLEAR AREA</button>
          </div>
          <p class="font-mono text-[10px] text-[#888]">Grand taxis: no area (NONE) — license boundary applies to Petit only.</p>
        </div>

        <!-- order simulation -->
        <div class="rounded-xl border border-white/25 bg-white/5 p-3 space-y-2">
          <p class="font-black text-[10px] tracking-[0.2em] text-[#aaa]">ORDER SIMULATION → REAL R1.MATCH</p>
          <div class="grid grid-cols-3 gap-2 font-mono text-[10px]">
            <label>SERVICE
              <select v-model="genForm.service" class="w-full bg-black border border-white px-1 py-1.5 mt-1">
                <option value="petit_taxi">🐟 Petit</option>
                <option value="grand_taxi">🚐 Grand</option>
              </select>
            </label>
            <label>COUNT
              <input v-model.number="genForm.count" type="number" min="1" max="50" class="w-full bg-black border border-white px-1 py-1.5 mt-1" />
            </label>
            <label class="text-[#aaa]">PAX CAP
              <span class="w-full block bg-black border border-white/25 px-1 py-1.5 mt-1 text-center text-white font-mono">{{ SERVICE_CAPS[genForm.service] }}</span>
            </label>
            <label>PAX MIN
              <input v-model.number="genForm.minPax" type="number" min="1" max="20" class="w-full bg-black border border-white px-1 py-1.5 mt-1" />
            </label>
            <label>PAX MAX
              <input v-model.number="genForm.maxPax" type="number" min="1" max="20" class="w-full bg-black border border-white px-1 py-1.5 mt-1" />
            </label>
            <label>BAGS MAX
              <input v-model.number="genForm.maxBags" type="number" min="0" max="10" class="w-full bg-black border border-white px-1 py-1.5 mt-1" />
            </label>
          </div>
          <div>
            <p class="font-mono text-[10px] text-[#aaa] mb-1">PRIORITY DISTRIBUTION (Σ = 100)</p>
            <div class="grid grid-cols-4 gap-2 font-mono text-[10px]">
              <label>NORMAL <input v-model.number="genForm.prioNormal" type="number" min="0" max="100" class="w-full bg-black border border-white px-1 py-1 mt-1" /></label>
              <label>HIGH <input v-model.number="genForm.prioHigh" type="number" min="0" max="100" class="w-full bg-black border border-white px-1 py-1 mt-1" /></label>
              <label>URGENT <input v-model.number="genForm.prioUrgent" type="number" min="0" max="100" class="w-full bg-black border border-white px-1 py-1 mt-1" /></label>
              <label>EMERG <input v-model.number="genForm.prioEmergency" type="number" min="0" max="100" class="w-full bg-black border border-white px-1 py-1 mt-1" /></label>
            </div>
          </div>
          <label class="flex items-center justify-between font-mono text-[10px] text-[#aaa]">PRIVATE PROBABILITY
            <div class="flex items-center gap-2">
              <input v-model.number="genForm.privateProb" type="number" min="0" max="100" class="w-16 bg-black border border-white px-1 py-1.5 text-center" />
              <span>%</span>
            </div>
          </label>
          <p class="font-mono text-[10px] text-[#888]">Generated orders carry a <span class="text-white">service</span> tag; REAL R1 enforces {{ genForm.service === 'petit_taxi' ? 'the H3 operating area' : 'no area (NONE)' }} + capacity + corridor.</p>
          <button @click="generateOrdersUI" class="w-full bg-white text-black font-black text-xs py-2 hover:bg-[#bbb]">⚡ GENERATE {{ genForm.count }} {{ genForm.service === 'petit_taxi' ? 'PETIT' : 'GRAND' }} ORDERS</button>
        </div>
        </template>
      </div>
    </div>

    <!-- TEST SETUP MODAL -->
    <div v-if="showSetup" class="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div class="r1pop bg-[#111] border border-white/30 rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.8)] w-[430px] max-w-full max-h-full overflow-y-auto p-5 space-y-3">
        <p class="font-black tracking-widest text-sm">⚙ NEW TEST RUN</p>
        <div class="grid grid-cols-2 gap-2 font-mono text-[11px]">
          <label class="col-span-2">CITY
            <select v-model="testForm.city" class="w-full bg-black border border-white px-2 py-1.5 mt-1">
              <option v-for="(_, name) in CITIES" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <label>TEST TIMER (sim time)
            <select v-model="testForm.duration" class="w-full bg-black border border-white px-2 py-1.5 mt-1">
              <option value="900">15 min</option>
              <option value="1800">30 min</option>
              <option value="3600">1 hour</option>
              <option value="7200">2 hours</option>
            </select>
          </label>
          <label>🚕 PETIT TAXIS
            <input v-model.number="testForm.petit" type="number" min="1" max="50" class="w-full bg-black border border-white px-2 py-1.5 mt-1" />
          </label>
          <label>🚐 GRAND TAXIS
            <input v-model.number="testForm.grand" type="number" min="0" max="50" class="w-full bg-black border border-white px-2 py-1.5 mt-1" />
          </label>
          <label>RATE (MAD / km)
            <input v-model.number="testForm.rate" type="number" step="0.1" min="0" class="w-full bg-black border border-white px-2 py-1.5 mt-1" />
          </label>
          <label>BASE FARE (MAD)
            <input v-model.number="testForm.base" type="number" step="0.5" min="0" class="w-full bg-black border border-white px-2 py-1.5 mt-1" />
          </label>
          <label class="col-span-2">RIDE TYPE
            <select v-model="testForm.mode" class="w-full bg-black border border-white px-2 py-1.5 mt-1">
              <option value="shared">Shared (group) × 1.0</option>
              <option value="private">Private × 1.6</option>
            </select>
          </label>
          <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" v-model="testForm.night" class="accent-white" /> NIGHT SHIFT × 1.25</label>
          <label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" v-model="testForm.bags" class="accent-white" /> BAGS +
            <input v-model.number="testForm.bagsFee" type="number" step="0.5" min="0" class="w-16 bg-black border border-white px-1 py-0.5" /> MAD</label>
          <label class="col-span-2 flex items-center gap-2 cursor-pointer"><input type="checkbox" v-model="testForm.live" class="accent-white" /> LIVE RANDOM ORDERS DURING TEST</label>
          <label class="col-span-2 flex items-center gap-2 cursor-pointer"><input type="checkbox" v-model="testForm.priority" class="accent-amber-400" /> 🔀 START WITH A PRIORITY BATCH (every tier 0-3)</label>
        </div>
        <p class="font-mono text-[10px] text-[#888]">price = distance × {{ testForm.rate }} + {{ testForm.base }} base{{ testForm.mode === 'private' ? ' × 1.6 private' : '' }}{{ testForm.night ? ' × 1.25 night' : '' }}{{ testForm.bags ? ` + ${testForm.bagsFee} bags` : '' }}</p>
        <div class="grid grid-cols-2 gap-2">
          <button @click="showSetup = false" class="border border-white font-black text-xs py-2 hover:bg-white hover:text-black">CANCEL</button>
          <button @click="startTest" class="bg-white text-black font-black text-xs py-2 hover:bg-[#888]">▶ START TEST</button>
        </div>
      </div>
    </div>

    <!-- RESULTS MODAL -->
    <div v-if="showResults && results" class="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div class="r1pop bg-[#111] border border-white/30 rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.8)] w-[660px] max-w-full max-h-full overflow-y-auto p-5 space-y-3">
        <div class="flex items-center justify-between">
          <p class="font-black tracking-widest text-sm">📊 TEST RESULTS — {{ results.city }} · {{ results.simTime }}</p>
          <button @click="showResults = false" class="border border-white font-black text-xs px-3 py-1 hover:bg-white hover:text-black">✕ CLOSE</button>
        </div>
        <div class="grid grid-cols-4 gap-1.5 font-mono text-center">
          <div class="rounded-xl border border-green-500/40 bg-green-500/10 p-2"><p class="text-2xl font-black text-green-400">{{ results.completed }}</p><p class="text-[10px] text-[#888]">COMPLETED</p></div>
          <div class="rounded-xl border border-red-500/40 bg-red-500/10 p-2"><p class="text-2xl font-black text-red-400">{{ results.canceled }}</p><p class="text-[10px] text-[#888]">CANCELED</p></div>
          <div class="rounded-xl border border-white/20 bg-white/5 p-2"><p class="text-2xl font-black">{{ results.active }}</p><p class="text-[10px] text-[#888]">STILL ACTIVE</p></div>
          <div class="rounded-xl border border-white/20 bg-white/5 p-2"><p class="text-2xl font-black">{{ results.completionPct }}%</p><p class="text-[10px] text-[#888]">COMPLETION</p></div>
          <div class="rounded-xl border border-green-500/40 bg-green-500/10 p-2"><p class="text-2xl font-black text-green-400">{{ results.revenue }}</p><p class="text-[10px] text-[#888]">REVENUE MAD</p></div>
          <div class="rounded-xl border border-white/20 bg-white/5 p-2"><p class="text-2xl font-black">{{ results.avgFare }}</p><p class="text-[10px] text-[#888]">AVG FARE</p></div>
          <div class="rounded-xl border border-white/20 bg-white/5 p-2"><p class="text-2xl font-black">{{ fmtAge(results.avgWait) }}</p><p class="text-[10px] text-[#888]">AVG WAIT</p></div>
          <div class="rounded-xl border border-white/20 bg-white/5 p-2"><p class="text-2xl font-black">{{ results.taxis }}</p><p class="text-[10px] text-[#888]">TAXIS</p></div>
        </div>
        <p class="font-mono text-[10px] text-[#888]">{{ results.tariff }} · {{ results.declines }} declines logged</p>
        <div class="grid grid-cols-1 md:grid-cols-5 gap-2">
          <div class="md:col-span-3 border border-white/20 rounded-lg p-2 h-52">
            <canvas v-if="results.rides.length" ref="revCanvas"></canvas>
            <p v-else class="font-mono text-[11px] text-[#888]">No completed rides.</p>
          </div>
          <div class="md:col-span-2 border border-white/20 rounded-lg p-2 h-52">
            <canvas ref="statusCanvas"></canvas>
          </div>
        </div>
        <div v-if="(results.series || []).length > 1" class="border border-white/20 rounded-lg p-2 h-56">
          <canvas ref="seriesCanvas"></canvas>
        </div>
        <div class="max-h-40 overflow-y-auto font-mono text-[10px]">
          <div class="grid grid-cols-[3rem_1fr_4rem_4rem_4rem] gap-1 px-1 py-0.5 text-[#888] border-b border-white/30"><span>ID</span><span>FROM → TO</span><span>KM</span><span>WAIT</span><span class="text-right">MAD</span></div>
          <div v-for="r in results.rides" :key="r.id" class="grid grid-cols-[3rem_1fr_4rem_4rem_4rem] gap-1 px-1 py-0.5 border-b border-white/10">
            <span :style="{ color: orderColor(r) }">{{ r.id }}</span>
            <span class="truncate">{{ r.pickupLabel }} → {{ r.dropoffLabel }}</span>
            <span>{{ r.directKm }}</span><span>{{ fmtAge(r.waitSec || 0) }}</span>
            <span class="text-right text-green-400">{{ r.lockedFare ?? r.fare }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
@import 'leaflet/dist/leaflet.css';
.leaflet-container { background: #111; font-family: monospace; }
@keyframes r1pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
@keyframes r1pop { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: none; } }
.r1pop { animation: r1pop 0.18s ease-out; }
button { transition: background-color 0.15s, color 0.15s, border-color 0.15s; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.25); border-radius: 8px; }
::-webkit-scrollbar-track { background: transparent; }
.leaflet-popup-content-wrapper { background: #111; color: #fff; border: 1px solid rgba(255,255,255,0.3); border-radius: 12px; }
.leaflet-popup-tip { background: #111; border: 1px solid rgba(255,255,255,0.3); }
.leaflet-popup-content { font-family: monospace; font-size: 11px; line-height: 1.5; }
</style>
