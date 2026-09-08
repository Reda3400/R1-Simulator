import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell, polygonToCells, gridPathCells, cellToLatLng } from 'h3-js';
import {
  cellPolygon, makeEditor, toggleCell, removeCell, clearCells, removeLastCell,
  loadEditor, saveEditor, editorHasArea, addVertex, closePolygon, currentRing,
  removeLastVertex, clearVerts, autoCompleteZone, refreshAutoFill, blobAnchor,
} from '../src/h3Area.js';
import { H3_RES, areaCells, setArea } from '../src/cityConfig.js';
import { createCity } from '../src/cityConfig.js';

function cell(lat, lng) { return latLngToCell(lat, lng, H3_RES); }

test('makeEditor defaults', () => {
  const e = makeEditor('petit_taxi');
  assert.equal(e.service, 'petit_taxi');
  assert.equal(e.active, false);
  assert.equal(e.cells.size, 0);
  assert.equal(e.dirty, false);
  assert.equal(editorHasArea(e), false);
});

test('toggleCell adds and removes', () => {
  const e = makeEditor('petit_taxi');
  const c = cell(33.589, -7.62);
  toggleCell(e, c);
  assert.ok(e.cells.has(c));
  assert.ok(e.dirty);
  toggleCell(e, c);
  assert.ok(!e.cells.has(c));
  assert.ok(e.dirty);
});

test('removeCell + clearCells mark dirty only on change', () => {
  const e = makeEditor('petit_taxi');
  const c = cell(33.589, -7.62);
  toggleCell(e, c);
  removeCell(e, c);
  assert.equal(e.cells.size, 0);
  // no-op clear on empty set does not dirty
  e.dirty = false;
  clearCells(e);
  assert.equal(e.dirty, false);
  // clear on non-empty set dirties
  toggleCell(e, cell(33.6, -7.63));
  clearCells(e);
  assert.ok(e.dirty);
});

test('removeLastCell pops the most recently added cell (undo)', () => {
  const e = makeEditor('petit_taxi');
  toggleCell(e, 'a'); toggleCell(e, 'b'); toggleCell(e, 'c');
  e.dirty = false;
  removeLastCell(e);
  assert.deepEqual([...e.cells].sort(), ['a', 'b']);
  assert.ok(e.dirty);
  removeLastCell(e);
  assert.deepEqual([...e.cells].sort(), ['a']);
  removeLastCell(e);
  assert.equal(e.cells.size, 0);
  // empty editor: no-op
  removeLastCell(e);
});

test('loadEditor mirrors stored area', () => {
  const c = createCity({ city_id: 'ld' });
  setArea(c, 'petit_taxi', { allowed_cells: ['a', 'b'] });
  const e = makeEditor('petit_taxi');
  loadEditor(c, e);
  assert.deepEqual([...e.cells].sort(), ['a', 'b']);
  assert.equal(e.dirty, false);
});

test('saveEditor commits cells to the city + returns R1-shaped area', () => {
  const c = createCity({ city_id: 'sv' });
  const e = makeEditor('petit_taxi');
  const a = cell(33.589, -7.62), b = cell(33.6, -7.63);
  toggleCell(e, a); toggleCell(e, b);
  const saved = saveEditor(c, e);
  assert.deepEqual([...saved.allowed_cells].sort(), [a, b].sort());
  assert.deepEqual(areaCells(c, 'petit_taxi').sort(), [a, b].sort());
  assert.equal(e.dirty, false);
});

test('grand taxi editor never saves an area (stays null)', () => {
  const c = createCity({ city_id: 'gr' });
  const e = makeEditor('grand_taxi');
  const saved = saveEditor(c, e);
  assert.equal(saved, null);
});

test('cellPolygon returns a closed polygon of [lat,lng] pairs', () => {
  const poly = cellPolygon(latLngToCell(33.589, -7.62, H3_RES));
  assert.ok(poly.length >= 6);
  assert.ok(poly.every(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng)));
});

// ---------- polygon edges mode + AUTO-COMPLETE ----------

function v(e, lat, lng) { addVertex(e, { lat, lng }); }

test('addVertex flips the editor into edges mode', () => {
  const e = makeEditor('petit_taxi');
  assert.equal(e.mode, 'cells');
  v(e, 33.6, -7.63);
  assert.equal(e.mode, 'edges');
  assert.equal(e.verts.length, 1);
  assert.deepEqual(e.verts[0], [33.6, -7.63]);
});

test('currentRing closes vertex runs (first == last)', () => {
  const e = makeEditor('petit_taxi');
  v(e, 33.60, -7.63); v(e, 33.62, -7.60); v(e, 33.64, -7.63);
  const ring = currentRing(e);
  assert.ok(ring && ring.length === 4);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  // fewer than 3 vertices yields no ring
  assert.equal(currentRing(makeEditor('petit_taxi')), null);
});

test('closePolygon locks a ring and clears the pending vertices', () => {
  const e = makeEditor('petit_taxi');
  v(e, 33.60, -7.63); v(e, 33.62, -7.60); v(e, 33.64, -7.63);
  closePolygon(e);
  assert.equal(e.polys.length, 1);
  assert.equal(e.polys[0].length, 4);
  assert.equal(e.verts.length, 0);
  // closing twice creates a second independent blob
  v(e, 33.55, -7.58); v(e, 33.57, -7.55); v(e, 33.59, -7.58);
  closePolygon(e);
  assert.equal(e.polys.length, 2);
});

test('removeLastVertex pending-only; clearVerts resets pending + closed', () => {
  const e = makeEditor('petit_taxi');
  v(e, 33.60, -7.63); v(e, 33.62, -7.60); removeLastVertex(e);
  assert.equal(e.verts.length, 1);
  v(e, 33.64, -7.63); v(e, 33.66, -7.60); closePolygon(e);
  assert.equal(e.polys.length, 1);
  clearVerts(e);
  assert.equal(e.verts.length, 0);
  assert.equal(e.polys.length, 0);
});

test('autoCompleteZone fills every blob + links blobs with a hex corridor', () => {
  const e = makeEditor('petit_taxi');
  // two separate blobs ~ a couple of km apart on the Casablanca grid
  const blobA = [[33.600, -7.640], [33.610, -7.630], [33.605, -7.620]];
  const blobB = [[33.600, -7.580], [33.610, -7.570], [33.605, -7.560]];
  for (const [la, ln] of blobA) v(e, la, ln);
  closePolygon(e);
  for (const [la, ln] of blobB) v(e, la, ln);
  closePolygon(e);

  const expectedA = polygonToCells([...blobA, blobA[0]], H3_RES, false);
  const expectedB = polygonToCells([...blobB, blobB[0]], H3_RES, false);
  assert.ok(expectedA.length, 'blob A rasterizes');
  assert.ok(expectedB.length, 'blob B rasterizes');

  autoCompleteZone(e);
  const got = e.cells;
  assert.ok([...expectedA].every((c) => got.has(c)), 'blob A fully filled');
  assert.ok([...expectedB].every((c) => got.has(c)), 'blob B fully filled');

  // corridor: the anchor-to-anchor hex path is PART of the committed zone
  const anchorA = blobAnchor(expectedA);
  const anchorB = blobAnchor(expectedB);
  assert.ok(anchorA !== anchorB, 'blobs resolve to distinct anchors');
  const path = gridPathCells(anchorA, anchorB);
  assert.ok(path.length >= 2, `corridor path exists (${path.length} cells)`);
  assert.ok(path.every((c) => got.has(c)), 'every corridor cell is in the committed zone');

  // working set is contiguous-ish: union + corridor > either blob alone
  assert.ok(got.size >= expectedA.length && got.size > expectedA.length, 'zone grows beyond one blob (corridor added)');
});

test('autoCompleteZone with no closed blobs is a no-op', () => {
  const e = makeEditor('petit_taxi');
  const before = e.cells.size;
  autoCompleteZone(e);
  assert.equal(e.cells.size, before);
});

test('refreshAutoFill is LIVE: fills as soon as 3 vertices land, keeps verts for further drawing', () => {
  const e = makeEditor('petit_taxi');
  refreshAutoFill(e);
  assert.equal(e.cells.size, 0, 'no geometry yet → still empty');
  v(e, 33.600, -7.640); refreshAutoFill(e);
  assert.equal(e.cells.size, 0, '1 vertex → no fill yet');
  v(e, 33.610, -7.630); refreshAutoFill(e);
  assert.equal(e.cells.size, 0, '2 vertices → still no fill (no area)');
  v(e, 33.605, -7.620); refreshAutoFill(e);
  const first = e.cells.size;
  assert.ok(first > 0, '3rd vertex opens the polygon → auto-filled');

  // verts REMAIN (live editing) — the user keeps drawing; SAVE reads editor.cells
  assert.equal(e.verts.length, 3);
  assert.ok(e.order.length === e.cells.size, 'order mirrors cells');

  // nothing was excluded → identical refill
  refreshAutoFill(e);
  assert.equal(e.cells.size, first, 'refill is idempotent');
});

test('refreshAutoFill erases excluded hexes and never resurrects them', () => {
  const e = makeEditor('petit_taxi');
  v(e, 33.600, -7.640); v(e, 33.610, -7.630); v(e, 33.605, -7.620);
  refreshAutoFill(e);
  const first = [...e.cells];

  const drop = first[0];
  e.excluded.add(drop);
  e.cells.delete(drop);
  e.dirty = true;
  refreshAutoFill(e); // e.g. a vertex was added afterwards
  assert.ok(!e.cells.has(drop), 'excluded hex stays out after refill');

  // cancel an exclusion with a second interior click → hex comes back if under a fill
  e.excluded.delete(drop);
  refreshAutoFill(e);
  assert.ok(e.cells.has(drop), 'un-excluding restores the hex on next refill');
});

test('closePolygon + refreshAutoFill = lock a blob and re-fill (KEEP BLOB flow)', () => {
  const e = makeEditor('petit_taxi');
  const blob = [[33.600, -7.640], [33.610, -7.630], [33.605, -7.620]];
  for (const [la, ln] of blob) v(e, la, ln);
  refreshAutoFill(e);
  const blobCells = e.cells.size;
  assert.ok(blobCells > 0);
  closePolygon(e);
  refreshAutoFill(e);
  assert.equal(e.polys.length, 1, 'blob locked into a closed ring');
  assert.equal(e.verts.length, 0, 'pending vertices cleared after lock');
  assert.equal(e.cells.size, blobCells, 'locked blob keeps its fill');
});

test('autoCompleteZone feeds the existing SAVE pipeline (cells → city area)', () => {
  const c = createCity({ city_id: 'ac' });
  const e = makeEditor('petit_taxi');
  const blob = [[33.600, -7.640], [33.610, -7.630], [33.605, -7.620]];
  for (const [la, ln] of blob) v(e, la, ln);
  closePolygon(e);
  autoCompleteZone(e);
  const saved = saveEditor(c, e);
  assert.ok(saved && saved.allowed_cells.length >= 5, 'auto-completed area commits to the city');
  assert.deepEqual(areaCells(c, 'petit_taxi').sort(), saved.allowed_cells.slice().sort());
});