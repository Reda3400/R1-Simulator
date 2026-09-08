import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  H3_RES, SERVICES, defaultCities, createCity, setArea, operatingAreaArg, areaCells,
  serviceEnabled, toJSON, fromJSON, grandTaxiArea,
} from '../src/cityConfig.js';

test('boot ships with ZERO seeded cities (setup wizard supplies the first)', () => {
  const d = defaultCities();
  assert.equal(d.length, 0);
  assert.deepEqual(d, []);
});

test('city create defaults', () => {
  const c = createCity({ city_id: 'x', city_name: 'Test City' });
  assert.equal(c.city_id, 'x');
  assert.equal(c.city_name, 'Test City');
  assert.equal(c.services.petit_taxi, true);
  assert.equal(c.services.grand_taxi, false);
  assert.ok(SERVICES.includes('petit_taxi'));
  assert.ok(SERVICES.includes('grand_taxi'));
});

test('grand taxi has no operating area', () => {
  const c = createCity({ city_id: 'g' });
  assert.equal(grandTaxiArea(), null);
  assert.equal(operatingAreaArg(c, 'grand_taxi'), null);
});

test('setArea stores allowed_cells on the city', () => {
  const c = createCity({ city_id: 'p' });
  const area = setArea(c, 'petit_taxi', { h3_resolution: 9, allowed_cells: ['a', 'b'] });
  assert.ok(area);
  assert.deepEqual(area.allowed_cells, ['a', 'b']);
  assert.equal(area.service, 'petit_taxi');
  assert.deepEqual(areaCells(c, 'petit_taxi'), ['a', 'b']);
});

test('petit operatingAreaArg returns R1-ready shape (res + cells)', () => {
  const c = createCity({ city_id: 'p' });
  setArea(c, 'petit_taxi', { h3_resolution: 8, allowed_cells: ['c1', 'c2'] });
  assert.deepEqual(operatingAreaArg(c, 'petit_taxi'), { h3_resolution: 8, cells: ['c1', 'c2'] });
});

test('petit with no area returns {} (no gate)', () => {
  const c = createCity({ city_id: 'empty' });
  assert.deepEqual(operatingAreaArg(c, 'petit_taxi'), {});
});

test('grand always null, never petit cells', () => {
  const c = createCity({ city_id: 'p' });
  setArea(c, 'petit_taxi', { allowed_cells: ['z'] });
  assert.equal(operatingAreaArg(c, 'grand_taxi'), null);
});

test('JSON round-trip preserves area cells + services', () => {
  const c = createCity({ city_id: 'j', city_name: 'JSON City', grand_taxi: true });
  setArea(c, 'petit_taxi', { allowed_cells: ['c1', 'c2', 'c3'] });
  const json = toJSON(c);
  assert.deepEqual(json.operating_areas.petit_taxi.allowed_cells, ['c1', 'c2', 'c3']);
  assert.equal(json.operating_areas.grand_taxi, null);
  assert.equal(json.services.grand_taxi, true);
  const back = fromJSON(json);
  assert.equal(back.city_id, 'j');
  assert.deepEqual(areaCells(back, 'petit_taxi'), ['c1', 'c2', 'c3']);
  assert.equal(serviceEnabled(back, 'grand_taxi'), true);
});

test('service enabled respects city config', () => {
  const noGrand = createCity({ city_id: 'ng' });
  assert.equal(serviceEnabled(noGrand, 'petit_taxi'), true);
  assert.equal(serviceEnabled(noGrand, 'grand_taxi'), false);
  const both = createCity({ city_id: 'b', grand_taxi: true });
  assert.equal(serviceEnabled(both, 'grand_taxi'), true);
});