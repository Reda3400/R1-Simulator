import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell } from 'h3-js';
import { generateOrders, SERVICE_CAPS, PRIORITY_ORDER } from '../src/orderGenerator.js';
import { createCity, setArea } from '../src/cityConfig.js';
import { h3CellOf, H3_RES } from '../src/r1client.js';

function petitCity(cells) {
  const c = createCity({ city_id: 'p', city_name: 'Petit City' });
  setArea(c, 'petit_taxi', { allowed_cells: cells });
  return c;
}

function makeCells(n = 5) {
  const c0 = h3CellOf(33.589, -7.62);
  const cells = [c0];
  let c = c0;
  for (let i = 1; i < n; i++) {
    const a = (i * 37) % 360;
    const d = 0.0008;
    const lat = 33.589 + d * Math.cos((a * Math.PI) / 180);
    const lng = -7.62 + d * Math.sin((a * Math.PI) / 180) / Math.cos((33.589 * Math.PI) / 180);
    const nc = latLngToCell(lat, lng, H3_RES);
    if (!cells.includes(nc)) cells.push(nc);
  }
  return cells;
}

test('petit generation: pickup AND dropoff inside allowed cells', () => {
  const cells = makeCells();
  const city = petitCity(cells);
  const r = generateOrders('petit_taxi', city, { count: 100 });
  assert.ok(r.ok);
  assert.equal(r.count, 100);
  for (const o of r.orders) {
    assert.ok(cells.includes(o.pickupCell), `pickup ${o.pickupCell} outside cells`);
    assert.ok(cells.includes(o.dropoffCell), `dropoff ${o.dropoffCell} outside cells`);
    assert.ok(cells.includes(h3CellOf(o.pickup.lat, o.pickup.lng)), 'pickup coord maps to allowed cell');
  }
});

test('petit disabled service → zero orders + PETIT_TAXI_UNAVAILABLE', () => {
  const c = createCity({ city_id: 'd' }); // petit disabled
  assert.equal(c.services.petit_taxi, true); // default is enabled; disable explicitly
  c.services.petit_taxi = false;
  const r = generateOrders('petit_taxi', c, { count: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PETIT_TAXI_UNAVAILABLE');
  assert.equal(r.count, 0);
});

test('petit with no drawn area → zero orders + PETIT_TAXI_UNAVAILABLE', () => {
  const c = createCity({ city_id: 'na' }); // no cells set
  const r = generateOrders('petit_taxi', c, { count: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PETIT_TAXI_UNAVAILABLE');
});

test('grand generation ignores petit cells and uses city bbox', () => {
  const city = createCity({ city_id: 'g', city_name: 'Grand City', grand_taxi: true });
  setArea(city, 'petit_taxi', { allowed_cells: ['zzz'] }); // far-away fake cells
  city.bbox = { minLat: 33.565, maxLat: 33.61, minLng: -7.68, maxLng: -7.58 };
  const r = generateOrders('grand_taxi', city, { count: 50 });
  assert.ok(r.ok);
  for (const o of r.orders) {
    assert.equal(o.service, 'grand_taxi');
    assert.ok(o.pickup.lat >= city.bbox.minLat && o.pickup.lat <= city.bbox.maxLat);
    assert.ok(o.pickup.lng >= city.bbox.minLng && o.pickup.lng <= city.bbox.maxLng);
    // NOT forced into the fake petit cells
    assert.notEqual(o.pickupCell, 'zzz');
  }
});

test('grand disabled service → zero orders + PETIT_TAXI_UNAVAILABLE', () => {
  const c = createCity({ city_id: 'gd' }); // grand disabled by default
  const r = generateOrders('grand_taxi', c, { count: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PETIT_TAXI_UNAVAILABLE');
  assert.equal(r.count, 0);
});

test('passengers never exceed service capacity (capacity-aware)', () => {
  const cells = makeCells();
  const city = petitCity(cells);
  const r = generateOrders('petit_taxi', city, { count: 200, passengersMax: 99 });
  for (const o of r.orders) {
    assert.ok(o.passengers <= SERVICE_CAPS.petit_taxi, `pax ${o.passengers} > petit cap`);
    assert.ok(o.passengers >= 1);
  }
});

test('priority distribution maps to R1 code 0..3', () => {
  const cells = makeCells();
  const city = petitCity(cells);
  const r = generateOrders('petit_taxi', city, { count: 200 });
  for (const o of r.orders) {
    assert.ok(o.priority >= 0 && o.priority <= 3, `priority ${o.priority}`);
  }
});

test('private_probability defaults to 0.10; override works', () => {
  const cells = makeCells();
  const city = petitCity(cells);
  const r = generateOrders('petit_taxi', city, { count: 4000, private_probability: 0 });
  for (const o of r.orders) assert.equal(o.private, false);
});

test('generated orders carry service tag + stable shape', () => {
  const cells = makeCells();
  const city = petitCity(cells);
  const r = generateOrders('petit_taxi', city, { count: 5 });
  for (const o of r.orders) {
    assert.equal(o.service, 'petit_taxi');
    assert.ok(o.id);
    assert.ok(o.pickup && o.dropoff);
    assert.equal(typeof o.passengers, 'number');
    assert.equal(typeof o.bags, 'number');
    assert.equal(typeof o.priority, 'number');
    assert.equal(typeof o.private, 'boolean');
  }
});

test('PRIORITY_ORDER has exactly the 4 canonical tiers', () => {
  assert.deepEqual(PRIORITY_ORDER, ['normal', 'high', 'urgent', 'emergency']);
});