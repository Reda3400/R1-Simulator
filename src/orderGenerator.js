// Order generator: creates service-aware orders whose pickup and dropoff are
// sampled inside the city's operating areas. Petit Taxi orders are generated
// ONLY inside the selected H3 cells (real cell-ring samples, not bbox random).
// Grand Taxi orders are independent of the petit area. Generated orders carry
// a `service` tag and feed through the REAL R1 engine for matching.
import { latLngToCell, cellToLatLng } from 'h3-js';
import { H3_RES, h3CellOf } from './r1client.js';
import { areaCells, serviceEnabled } from './cityConfig.js';
import { haversineM } from './r1client.js';

// ---- service capacity (passenger cap used to bound per-order passengers) ----
export const SERVICE_CAPS = { petit_taxi: 3, grand_taxi: 6 };

// ---- generation defaults (configurable in UI, not hard-coded) ----
export const GENERATOR_DEFAULTS = {
  count: 100,
  passengersMin: 1,
  passengersMax: 3, // capacity-aware upper bound default (see cap)
  bagsMin: 0,
  bagsMax: 2,
  priority_distribution: { normal: 0.70, high: 0.20, urgent: 0.08, emergency: 0.02 },
  private_probability: 0.10,
};

export const PRIORITY_ORDER = ['normal', 'high', 'urgent', 'emergency'];
export const PRIORITY_CODE = { normal: 0, high: 1, urgent: 2, emergency: 3 };

/// Weighted pick from a distribution object ({ key: weight }).
function pickWeighted(dist) {
  const entries = Object.entries(dist);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
  return entries[entries.length - 1][0];
}

function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

/// Sample a lat/lng uniformly inside an H3 cell (rejection-sample a small
/// box around the cell centroid, then snap — close enough for a simulator).
export function pointInCell(cell) {
  const c = cellToLatLng(cell);
  const dlat = 0.0008, dlng = 0.0009; // ~90m box around a res-9 hex (~0.1km²)
  for (let i = 0; i < 8; i++) {
    const lat = c[0] + (Math.random() * 2 - 1) * dlat;
    const lng = c[1] + (Math.random() * 2 - 1) * dlng;
    if (latLngToCell(lat, lng, H3_RES) === cell) return { lat, lng };
  }
  return { lat: c[0], lng: c[1] };
}

function samplePickupDropoff(cells) {
  const pc = cells[Math.floor(Math.random() * cells.length)];
  let dc = cells[Math.floor(Math.random() * cells.length)];
  const a = pointInCell(pc);
  let b = pointInCell(dc);
  // avoid degenerate <500m trips
  let guard = 0;
  while (haversineM(a, b) < 500 && guard++ < 20) {
    dc = cells[Math.floor(Math.random() * cells.length)];
    b = pointInCell(dc);
  }
  return { pickup: a, dropoff: b, pickupCell: pc, dropoffCell: dc };
}

function sampleGrand(city, poissonCity) {
  if (poissonCity && typeof poissonCity.randPOIBiased === 'function') return poissonCity.randPOIBiased();
  const b = city.bbox || { minLat: 33.565, maxLat: 33.61, minLng: -7.68, maxLng: -7.58 };
  return {
    lat: b.minLat + Math.random() * (b.maxLat - b.minLat),
    lng: b.minLng + Math.random() * (b.maxLng - b.minLng),
  };
}

function randPassengers(service, cfg) {
  const cap = SERVICE_CAPS[service] || 3;
  const hi = Math.min(cfg.passengersMax, cap); // capacity-aware: pax never exceeds vehicle cap
  return randInt(Math.max(1, cfg.passengersMin), Math.max(1, hi));
}

function randBags(cfg) {
  return randInt(cfg.bagsMin, cfg.bagsMax);
}

function randPriority(cfg) {
  return PRIORITY_CODE[pickWeighted(cfg.priority_distribution)] ?? 0;
}

/// R1-ready order payload (minus coords: filled per sample).
function baseOrder(service, seedId, cfg) {
  return {
    id: seedId,
    service,
    passengers: randPassengers(service, cfg),
    bags: randBags(cfg),
    priority: randPriority(cfg),
    private: Math.random() < cfg.private_probability,
    status: 'waiting',
  };
}

/// Generate `cfg.count` orders. Returns:
///   { ok:true, count, orders:[...] } — every order carries
///     { id, service, pickup:{lat,lng}, dropoff:{lat,lng}, pickupCell,
///       dropoffCell, passengers, bags, priority, private }
///   { ok:false, code:'PETIT_TAXI_UNAVAILABLE', count:0, orders:[] } when a
///     petit generation is requested but the service is disabled or has no area.
export function generateOrders(service, city, cfg = {}) {
  const c = { ...GENERATOR_DEFAULTS, ...cfg };
  const enabled = serviceEnabled(city, service);
  if (!enabled) {
    return { ok: false, code: 'PETIT_TAXI_UNAVAILABLE', count: 0, orders: [] };
  }
  if (service === 'petit_taxi') {
    const cells = areaCells(city, 'petit_taxi');
    if (!cells.length) {
      return { ok: false, code: 'PETIT_TAXI_UNAVAILABLE', count: 0, orders: [] };
    }
    const orders = [];
    let seed = 1;
    for (let i = 0; i < c.count; i++) {
      const { pickup, dropoff, pickupCell, dropoffCell } = samplePickupDropoff(cells);
      orders.push({
        ...baseOrder(service, `G${String(seed++).padStart(3, '0')}`, c),
        pickup, dropoff, pickupCell, dropoffCell,
      });
    }
    return { ok: true, count: orders.length, orders };
  }
  // grand taxi: independent of petit cells, uses city/POI sampling.
  const orders = [];
  let seed = 1;
  for (let i = 0; i < c.count; i++) {
    const a = sampleGrand(city, c.citySampler);
    let b = sampleGrand(city, c.citySampler);
    let guard = 0;
    while (haversineM(a, b) < 500 && guard++ < 20) b = sampleGrand(city, c.citySampler);
    const pickupCell = h3CellOf(a.lat, a.lng);
    const dropoffCell = h3CellOf(b.lat, b.lng);
    orders.push({
      ...baseOrder(service, `G${String(seed++).padStart(3, '0')}`, c),
      pickup: { lat: a.lat, lng: a.lng },
      dropoff: { lat: b.lat, lng: b.lng },
      pickupCell, dropoffCell,
    });
  }
  return { ok: true, count: orders.length, orders };
}
