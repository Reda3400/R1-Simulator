// R1 tool: thin adapter over the R1 engine (input + parameters -> result).
// The engine owns ALL intelligence (route/corridor/match/heatmap); this file
// only translates. App-owned concerns live below: clock, tariff, spawn data,
// tiny geo math for animation (haversine/bearing along an R1 geometry).
import { latLngToCell as h3Cell } from 'h3-js';
import { polygonToCells } from 'h3-js';
import { gridRing as _gridRing } from 'h3-js';

// ----- H3 proximity helpers (Uber H3, res 9 ≈ 0.1 km² city hexagons) -----
// Phase 2 dispatch: an order is offered to taxis ring-by-ring OUTWARD from the
// cell it was hailed in (same hex → nearest ring → … → whole city). The app
// indexes taxis by their current cell, so "nearest available taxi" is just a
// map lookup per ring.
export const H3_RES = 9;
export function h3CellOf(lat, lng) { return h3Cell(lat, lng, H3_RES); }
/// Exact cells at ring distance k (ring 0 = the origin cell itself).
export function h3Ring(originCell, k) {
  if (k === 0) return [originCell];
  try { return _gridRing(originCell, k); } catch { return []; }
}

export const R1_BASE =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_R1_BASE) ||
  '/__r1'; // same-origin: the engine runs inside the dev server — no separate process/port
export const HEAT_SEC = 300;
export const MAX_WAIT_SEC = 600;

// Provider configuration (developer-owned). Real OSRM roads by default via
// the public demo server — zero setup, just works. If it is unreachable or
// slow, the app drops to the offline mock automatically (see resolveRoads).
// Production: point osrmBaseUrl at YOUR server. R1 itself ships no default.
export const R1_PROVIDER = {
  routing: 'osrm',
  osrmBaseUrl: 'https://router.project-osrm.org',
  osrmFallbackUrl: 'https://routing.openstreetmap.de',
  profile: 'car',
  timeoutMs: 4000,
};
export function setProvider(p) { Object.assign(R1_PROVIDER, p); }

/// Liveness probe for the developer's OWN OSRM server (not R1, not the app).
/// Goes through R1 itself (same-origin) with a tiny 2-point route, so it
/// tests the exact path matching will use — and never hits browser CORS
/// limits (a local osrm-backend sends no CORS headers). Never throws.
export async function probeOsrm(baseUrl, timeoutMs = 1500) {
  try {
    const r = await R1.route(
      { start: [33.589, -7.62], destination: [33.5895, -7.619] },
      { routing: 'osrm', osrmBaseUrl: baseUrl, timeoutMs });
    return Array.isArray(r.geometry) && r.geometry.length > 0;
  } catch {
    return false;
  }
}

/// Structured R1 failure: engine-side (code+message), never a bare exception.
export class R1Error extends Error {
  constructor(code, message, path) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

// ---------- bridge ----------
async function post(path, body, params = {}) {
  const provider = { ...R1_PROVIDER, ...params.provider };
  let r;
  try {
    r = await fetch(`${R1_BASE}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routing: params.routing || provider.routing, parameters: r1params({ ...provider, ...params }), ...body }),
    });
  } catch {
    throw new R1Error('R1_UNREACHABLE', 'R1 endpoint unreachable — is `npm run dev` serving this page?', path);
  }
  if (!r.ok) throw new R1Error('R1_HTTP', `R1 ${path}: HTTP ${r.status}`, path);
  const out = await r.json();
  if (out && out.code && out.ok === false) throw new R1Error(out.code, out.message || out.error || path, path);
  return out;
}
export function r1params(p = {}) {
  return {
    h3Resolution: 9, hexWidth: 2, maxDetourRatio: 1.3, directionCheck: true,
    capacityLimit: p.capacityLimit ?? 3,
    priorityWeightM: p.priorityWeightM ?? 1500,  // preference metres per priority tier
    osrmBaseUrl: p.osrmBaseUrl, osrmFallbackUrl: p.osrmFallbackUrl,
    profile: p.profile, timeoutMs: p.timeoutMs,
    ...p.parameters,
  };
}
export const R1 = {
  async health() {
    let r;
    try {
      r = await fetch(`${R1_BASE}/health`);
    } catch {
      throw new R1Error('R1_UNREACHABLE', 'R1 endpoint unreachable', '/health');
    }
    if (!r.ok) throw new R1Error('R1_HTTP', 'R1 unhealthy', '/health');
    return r.json();
  },
  route: (b, p) => post('/route', b, p),
  distance: (b, p) => post('/distance', b, p),
  matrix: (b, p) => post('/matrix', b, p),
  nearest: (b, p) => post('/nearest', b, p),
  corridor: (b, p) => post('/corridor', b, p),
  area: (b, p) => post('/area', b, p),
  match: (b, p) => post('/match', b, p),
  matchOrders: (b, p) => post('/matchOrders', b, p),
  heatmap: (b, p) => post('/heatmap', b, p),
};

let _uid = 1, _did = 1;
export function resetIds() { _uid = 1; _did = 1; }
export const now = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
export function fmtAge(s = 0) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}

// ---------- tiny geo math (animation + remaining only; never matching) ----------
const RAD = Math.PI / 180;
export function haversineM(a, b) {
  const dLa = (b.lat - a.lat) * RAD, dLo = (b.lng - a.lng) * RAD;
  const s1 = Math.sin(dLa / 2), s2 = Math.sin(dLo / 2);
  const h = s1 * s1 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * s2 * s2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
export function bearingDeg(a, b) {
  const y = Math.sin((b.lng - a.lng) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lng - a.lng) * RAD);
  return ((Math.atan2(y, x) / RAD) + 360) % 360;
}
export function remainingOnRoute(pos, geom, idx) {
  if (!geom.length) return 0;
  let s = haversineM(pos, geom[Math.min(idx, geom.length - 1)]);
  for (let i = idx; i < geom.length - 1; i++) s += haversineM(geom[i], geom[i + 1]);
  return s;
}
export function inCorridorCells(corridorArr, lat, lng, res = 9) {
  try { return corridorArr.includes(h3Cell(lat, lng, res)); } catch { return false; }
}
export async function baseGridCells(bbox, res = 9) {
  const poly = [
    [bbox.minLat, bbox.minLng], [bbox.minLat, bbox.maxLng],
    [bbox.maxLat, bbox.maxLng], [bbox.maxLat, bbox.minLng],
  ];
  try { return await polygonToCells(poly, res); } catch { return []; }
}

// ---------- tariff (app-owned; pricing NEVER lives in R1 core) ----------
export const pricing = { rate: 2.4, base: 8, privateMult: 1.6, nightMult: 1.25, bagsFee: 0, mode: 'shared', night: false, bags: false };
export function setPricing(p) { Object.assign(pricing, p); }
export function calcFare(km) {
  let f = pricing.base + km * pricing.rate;
  if (pricing.mode === 'private') f *= pricing.privateMult;
  if (pricing.night) f *= pricing.nightMult;
  if (pricing.bags) f += pricing.bagsFee;
  return Math.round(f * 10) / 10;
}

// ---------- cities + spawn data (app-owned demand) ----------
export const CITIES = {
  Casablanca: {
    center: [33.589, -7.62],
    bbox: { minLat: 33.565, maxLat: 33.61, minLng: -7.68, maxLng: -7.58 },
    pois: [
      { n: 'Maârif — Twin Center', lat: 33.5868, lng: -7.6295 },
      { n: 'Gauthier — Marché', lat: 33.5925, lng: -7.6261 },
      { n: 'Bourgogne — Bd Anfa', lat: 33.5889, lng: -7.6389 },
      { n: 'Casa-Voyageurs', lat: 33.5962, lng: -7.5888 },
      { n: 'Casa-Port', lat: 33.6015, lng: -7.6142 },
      { n: 'Habous', lat: 33.5805, lng: -7.6166 },
      { n: 'Ain Diab Corniche', lat: 33.5745, lng: -7.6692 },
      { n: 'Derb Omar', lat: 33.5932, lng: -7.6122 },
    ],
  },
  Rabat: {
    center: [34.0209, -6.8416],
    bbox: { minLat: 33.995, maxLat: 34.045, minLng: -6.89, maxLng: -6.79 },
    pois: [
      { n: 'Agdal', lat: 34.003, lng: -6.847 }, { n: 'Médina', lat: 34.028, lng: -6.823 },
      { n: 'Hassan', lat: 34.023, lng: -6.833 }, { n: 'Hay Riad', lat: 34.008, lng: -6.862 },
    ],
  },
  Marrakech: {
    center: [31.6295, -7.9811],
    bbox: { minLat: 31.605, maxLat: 31.655, minLng: -8.03, maxLng: -7.93 },
    pois: [
      { n: 'Jemaa el-Fna', lat: 31.6258, lng: -7.9891 }, { n: 'Guéliz', lat: 31.6395, lng: -8.003 },
      { n: 'Palmeraie', lat: 31.66, lng: -7.96 }, { n: 'Menara', lat: 31.613, lng: -8.02 },
    ],
  },
};
export let activeCity = CITIES.Casablanca;
export function setCity(name) { activeCity = CITIES[name] || CITIES.Casablanca; return activeCity; }
export function randInBBox() {
  const b = activeCity.bbox;
  return { lat: b.minLat + Math.random() * (b.maxLat - b.minLat), lng: b.minLng + Math.random() * (b.maxLng - b.minLng) };
}
export function randPOIBiased() {
  if (Math.random() < 0.7) {
    const p = activeCity.pois[Math.floor(Math.random() * activeCity.pois.length)];
    const r = 600, a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
    return { lat: p.lat + (d * Math.cos(a)) / 111320, lng: p.lng + (d * Math.sin(a)) / (111320 * Math.cos(p.lat * RAD)), label: p.n };
  }
  return { ...randInBBox(), label: 'Street hail' };
}

// ---------- entity factories (app owns state; R1 fills intelligence later) ----------
export const DRIVER_TYPES = [
  { type: 'petit', label: 'Petit taxi', cap: 3, bagCap: 2 },
  { type: 'grand', label: 'Grand taxi', cap: 6, bagCap: 6 },
];
export function randDriverType() { return Math.random() < 0.6 ? 'petit' : 'grand'; } // 60/40 city/intercity mix
export function makeDriver(over = {}) {
  const p = over.pos || randPOIBiased();
  const id = over.id || `T${String(_did++).padStart(2, '0')}`;
  const type = over.type ?? (over.grand ? 'grand' : over.petit ? 'petit' : randDriverType());
  const spec = DRIVER_TYPES.find((t) => t.type === type) || DRIVER_TYPES[0];
  const cap = over.passengerCapacity ?? over.capacity ?? spec.cap; // passenger capacity wins; legacy capacity mirrors it
  return {
    id, pos: { lat: p.lat, lng: p.lng }, heading: Math.random() * 360,
    speed: 9 + Math.random() * 4, type,
    seats: 0, bags: 0, capacity: cap, passengerCapacity: cap, bagCapacity: over.bagCapacity ?? spec.bagCap,
    privateRide: false, available: true,
    routeGeometry: [], routeIdx: 0, corridor: [], deciderId: null,
    stops: [], bookings: [], declines: [], _declineKeys: new Set(),
    trail: [{ lat: p.lat, lng: p.lng }], acceptedPts: [], pickupPts: [], dropPts: [],
    state: 'available', log: [], _routeSig: null, _idleNew: false, _idleRefreshAt: -60000, _idleFetching: false,
  };
}
export function makeOrderShell(over = {}) {
  const a = over.pickup || randPOIBiased();
  let b = over.dropoff || randPOIBiased();
  if (haversineM(a, b) < 500) b = randInBBox();
  const id = over.id || `U${String(_uid++).padStart(2, '0')}`;
  const passengers = over.passengers ?? 1;
  return {
    id, pickup: { lat: a.lat, lng: a.lng }, dropoff: { lat: b.lat, lng: b.lng },
    pickupLabel: a.label || 'Pickup', dropoffLabel: b.label || 'Dropoff',
    passengers, bags: over.bags ?? 0, priority: over.priority ?? 0,
    private: over.private ?? false,
    service: over.service ?? null, // 'petit_taxi' | 'grand_taxi' | null (legacy unrestricted)
    served: 0,   // pax claimed by assigned taxis (picked up or en route)
    delivered: 0, // pax dropped off so far
    taxis: [],   // taxiIds currently serving this order (split group)
    fare: 0, directKm: 0, status: 'waiting', driverId: null, state: 'placed',
    placedAt: now(), lockedFare: null, ageSec: 0, waitSec: null, osrm: null,
  };
}
/// Price an order with R1 road distance + local tariff.
export async function priceOrder(o) {
  const r = await R1.route({ start: [o.pickup.lat, o.pickup.lng], destination: [o.dropoff.lat, o.dropoff.lng] });
  o.directKm = Math.round((r.distance / 1000) * 100) / 100;
  o.fare = calcFare(o.directKm);
  return o;
}

// ---------- realistic random demand ----------
// Loose Poisson-ish mix of passenger counts, bag counts, private rides and
// priority tiers so live/spawned orders mirror real life: solos, groups,
// luggage, corporate/urgent, private VIP rides. All random by design — R1
// still enforces hard capacity/private constraints and uses priority only
// as a preference among compatible candidates.
const PAX_TABLE = [   // [pax, weight]
  [1, 62], [2, 22], [3, 9], [4, 5], [6, 1], [8, 1],
];
const BAG_TABLE = [   // [bags, weight]
  [0, 58], [1, 20], [2, 11], [3, 6], [5, 3], [8, 2],
];
const PRIO_TABLE = [  // [priority tier, weight]
  [0, 70], [1, 16], [2, 10], [3, 4],
];
function pickWeighted(table) {
  let total = 0; for (const [, w] of table) total += w;
  let r = Math.random() * total;
  for (const [val, w] of table) { r -= w; if (r <= 0) return val; }
  return table[table.length - 1][0];
}
export function randomOrderAttrs() {
  return {
    passengers: pickWeighted(PAX_TABLE),
    bags: pickWeighted(BAG_TABLE),
    priority: pickWeighted(PRIO_TABLE),
    private: Math.random() < 0.08, // ~8% of live demand is a VIP/private ride
  };
}
/// A spawn-ready order with realistic random demographics (groups, bags,
/// private, urgent). Use for live demand, initial traffic and ＋ ADD.
export function makeRandomOrderShell(over = {}) {
  return makeOrderShell({ ...randomOrderAttrs(), ...over });
}

// ---------- R1 payload builders ----------
const ll = (p) => [p.lat, p.lng];
export function driverPayload(d) {
  return {
    id: d.id, pos: ll(d.pos), heading: d.heading,
    passenger_capacity: d.passengerCapacity || d.capacity,
    bag_capacity: d.bagCapacity,
    current_passengers: d.seats,
    current_bags: d.bags,
    private_active: !!d.privateRide,
    stops: d.stops.map((s) => ({ type: s.type, orderId: s.orderId, pt: ll(s.pt), passengers: s.passengers ?? 1, bags: s.bags ?? 0 })),
  };
}
export function orderPayload(o) {
  return {
    id: o.id, pickup: ll(o.pickup), dropoff: ll(o.dropoff),
    passengers: o.passengers ?? 1, bags: o.bags ?? 0,
    priority: o.priority ?? 0, private: !!o.private,
  };
}
export function stopsSig(d) {
  return d.stops.map((s) => `${s.type[0]}${s.pt.lat.toFixed(5)},${s.pt.lng.toFixed(5)}`).join('|');
}
