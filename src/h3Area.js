// H3 operating-area editor helpers: a mutable cell set that is the source of
// truth (never converted to a polygon). add/remove/clear/toggle on live cells;
// save() snapshots the working set into the city's stored area so that
// generated petit orders and matching immediately use the new cells.
//
// Two draw modes share the same working `cells` set:
//   - 'cells': click hexes to select/deselect (legacy fine-grained editing).
//   - 'edges': click the map to place polygon vertices; CLOSE POLYGON locks a
//     blob ring; AUTO-COMPLETE fills every blob's contained H3 cells AND links
//     the blobs into one continuous zone with a hex corridor.
// Save commits whatever the working `cells` set holds — mode-agnostic.
import { cellToLatLng, cellToBoundary, polygonToCells, gridPathCells, latLngToCell } from 'h3-js';
import { H3_RES, setArea, areaCells, serviceEnabled } from './cityConfig.js';

export function cellCenter(cell) {
  const c = cellToLatLng(cell);
  return { lat: c[0], lng: c[1] };
}

/// Boundary vertices [lat,lng][] for drawing the hex polygon on the map.
export function cellPolygon(cell) {
  return cellToBoundary(cell).map(([lat, lng]) => [lat, lng]);
}

export function colorFor(service) {
  return service === 'petit_taxi' ? '#38bdf8' : '#f59e0b';
}

export function makeEditor(service) {
  return {
    service,
    active: false,
    cells: new Set(),
    order: [], // insertion order — powers the "remove last" gesture
    dirty: false,
    mode: 'cells', // 'cells' | 'edges'
    verts: [],     // [lat,lng][] vertices of the ring currently being drawn
    polys: [],     // closed ring [lat,lng][] (first = last) per locked blob
    excluded: new Set(), // hexes the user erased from the auto-fill (never re-added)
  };
}

/// Commit the working set for a service into the city's stored area.
/// Returns the R1-ready area object (for matching + generation) or null for grand.
export function saveEditor(city, editor) {
  if (editor.service === 'grand_taxi') return null;
  const area = setArea(city, 'petit_taxi', {
    h3_resolution: H3_RES,
    allowed_cells: [...editor.cells],
  });
  editor.dirty = false;
  return area;
}

/// Reset the editor to the currently saved area for a service.
export function loadEditor(city, editor) {
  editor.cells = new Set(areaCells(city, editor.service));
  editor.order = [...editor.cells];
  editor.dirty = false;
}

export function toggleCell(editor, cell) {
  if (editor.cells.has(cell)) { editor.cells.delete(cell); editor.order = editor.order.filter((c) => c !== cell); }
  else { editor.cells.add(cell); editor.order.push(cell); }
  editor.dirty = true;
  return editor;
}

/// Remove the most recently added cell (undo step while drawing the area).
export function removeLastCell(editor) {
  const last = editor.order.pop();
  if (last) { editor.cells.delete(last); editor.dirty = true; }
  return editor;
}

export function removeCell(editor, cell) {
  if (editor.cells.delete(cell)) editor.dirty = true;
  return editor;
}

export function clearCells(editor) {
  if (editor.cells.size) { editor.cells.clear(); editor.order = []; editor.dirty = true; }
  return editor;
}

export function editorHasArea(editor) {
  return editor.cells.size > 0;
}

// ---------- polygon edges mode ----------

export function addVertex(editor, latlng) {
  editor.verts.push([latlng.lat, latlng.lng]);
  editor.mode = 'edges';
  editor.dirty = true;
  return editor;
}

export function currentRing(editor) {
  if (editor.verts.length < 3) return null;
  const ring = editor.verts.map(([la, ln]) => [la, ln]);
  ring.push([editor.verts[0][0], editor.verts[0][1]]); // close the loop
  return ring;
}

/// Lock the current vertex run into a closed polygon ring.
export function closePolygon(editor) {
  const ring = currentRing(editor);
  if (!ring) return editor;
  editor.polys.push(ring);
  editor.verts = [];
  editor.dirty = true;
  return editor;
}

export function removeLastVertex(editor) {
  editor.verts.pop();
  editor.dirty = true;
  return editor;
}

export function removeLastPoly(editor) {
  editor.polys.pop();
  editor.dirty = true;
  return editor;
}

export function clearVerts(editor) {
  if (editor.verts.length || editor.polys.length) { editor.verts = []; editor.polys = []; editor.dirty = true; }
  return editor;
}

/// Neighbour to `goal` nearest the mean of a blob's cells (the "anchor" cell
/// corridor chains pass through). Cost is trivial for ≤ a few hundred cells.
export function blobAnchor(cells) {
  const n = cells.length;
  let lat = 0, lng = 0;
  for (const c of cells) { const p = cellToLatLng(c); lat += p[0]; lng += p[1]; }
  const clat = lat / n, clng = lng / n;
  let best = cells[0], bd = Infinity;
  for (const c of cells) {
    const p = cellToLatLng(c);
    const d = (p[0] - clat) ** 2 + (p[1] - clng) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

/// Fill the working `cells` set from the drawn geometry:
///   1. Rasterize every locked blob ring + the current (open) vertex run.
///   2. Chain the blobs west→east through their anchor cells with a hex
///      corridor (gridPathCells), so the zone reads as ONE continuous area.
///   3. Drop every hex the user erased (editor.excluded) so live re-fills
///      never resurrect a manually removed hexagon.
/// LIVE in edges mode: called after every vertex add / blob lock / erase.
export function refreshAutoFill(editor) {
  const rings = editor.polys.map((r) => r.map(([la, ln]) => [la, ln]));
  const open = currentRing(editor);
  if (open) rings.push(open);
  if (!rings.length) return editor;
  const blobs = [];
  for (const ring of rings) {
    const cells = polygonToCells(ring, H3_RES, false);
    if (cells.length) blobs.push(cells);
  }
  if (!blobs.length) return editor;
  blobs.sort((a, b) => {
    const ca = blobAnchor(a), cb = blobAnchor(b);
    const pa = cellToLatLng(ca), pb = cellToLatLng(cb);
    return pa[1] - pb[1]; // west → east
  });
  const all = new Set();
  let prev = null;
  for (const b of blobs) {
    const anchor = blobAnchor(b);
    for (const c of b) all.add(c);
    if (prev && prev !== anchor) for (const c of gridPathCells(prev, anchor)) all.add(c);
    prev = anchor;
  }
  for (const c of editor.excluded) all.delete(c);
  editor.cells = all;
  editor.order = [...all];
  editor.dirty = true;
  return editor;
}

/// AUTO-COMPLETE the drawn zone (legacy entry, still available): fills every
/// blob + links them with the corridor — identical to the live edges auto-fill.
export function autoCompleteZone(editor) {
  return refreshAutoFill(editor);
}

// ---------- engine-driven live fill ----------

/// The rings to hand R1 `area`: locked blob rings (closed) + the open run.
export function ringsOfEditor(editor) {
  const rings = editor.polys.map((r) => r.map(([la, ln]) => [la, ln]));
  const open = currentRing(editor);
  if (open) rings.push(open);
  return rings;
}

/// Apply an R1 area result (its committed `cells`) to the editor's working
/// set — the engine drove the raster; the editor just stores it.
export function applyAreaCells(editor, cells) {
  editor.cells = new Set(cells);
  editor.order = [...editor.cells];
  editor.dirty = true;
  return editor;
}
