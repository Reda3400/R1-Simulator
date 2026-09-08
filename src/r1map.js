// App-owned Leaflet adapter — renders R1 result objects on a Leaflet map.
// Consumes R1 JSON only (route geometry, corridor cells, heat zones).
// This is application code, NOT part of R1 (R1 has no map dependency).
import { cellToBoundary } from 'h3-js';

const HEAT_STYLE = {
  red: { color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.5, weight: 1 },
  orange: { color: '#f97316', fillColor: '#f97316', fillOpacity: 0.38, weight: 1 },
  green: { color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.18, weight: 0.5 },
};

export class R1Map {
  /**
   * @param {object} leafletMap  an L.Map instance (you create tiles/center)
   * @param {object} opts  { L, routeStyle, corridorStyle, h3Style }
   *   L = the Leaflet namespace (or set R1Map.L = L once globally).
   */
  constructor(leafletMap, opts = {}) {
    if (!leafletMap) throw new Error('R1Map: Leaflet map instance required');
    this.map = leafletMap;
    this.L = opts.L || R1Map.L;
    if (!this.L) throw new Error('R1Map: pass { L } in opts or set R1Map.L = L');
    this.opts = {
      routeStyle: { color: '#000', weight: 4, opacity: 0.9 },
      corridorStyle: { color: '#555', weight: 0.5, fillColor: '#888', fillOpacity: 0.22 },
      h3Style: { color: '#fff', weight: 0.35, opacity: 0.35, fill: false, interactive: false },
      ...opts,
    };
    this.markers = new Map();
    this.layers = new Map(); // id -> L.Layer
  }

  // ---- markers ----
  addMarker(id, latlng, o = {}) {
    this.removeMarker(id);
    const L = this._leaflet();
    const m = o.icon
      ? L.marker(latlng, { icon: o.icon, draggable: !!o.draggable })
      : L.circleMarker(latlng, { radius: 7, color: '#000', weight: 1, fillColor: o.color || '#facc15', fillOpacity: 1 });
    if (o.popup) m.bindPopup(o.popup);
    if (o.onClick) m.on('click', o.onClick);
    if (o.onDragEnd) m.on('dragend', () => o.onDragEnd(m.getLatLng()));
    m.addTo(this.map);
    this.markers.set(id, m);
    return m;
  }
  removeMarker(id) {
    const m = this.markers.get(id);
    if (m) { m.remove(); this.markers.delete(id); }
  }
  getMarker(id) { return this.markers.get(id); }

  // ---- routes: geometry as [[lat,lng],...] (R1.route().geometry) ----
  drawRoute(id, geometry, style = {}) {
    this._set(id, this._leaflet().polyline(geometry, { ...this.opts.routeStyle, ...style }));
  }

  // ---- polygon outlines: rings [[lat,lng],...][] (zone-editor edges) ----
  drawPolys(id, rings, style = {}) {
    const L = this._leaflet();
    const group = L.layerGroup();
    const st = { ...this.opts.routeStyle, ...style };
    for (const ring of rings) {
      if (!ring || ring.length < 2) continue;
      group.addLayer(L.polyline(ring, st));
    }
    this._set(id, group);
  }

  // ---- corridors: string[] of H3 cells (R1.route().corridor) ----
  drawCorridor(id, cells, style = {}) {
    const L = this._leaflet();
    const group = L.layerGroup();
    const st = { ...this.opts.corridorStyle, ...style };
    for (const cell of cells) group.addLayer(L.polygon(cellToBoundary(cell), st));
    this._set(id, group);
  }

  // ---- raw H3 grid (e.g. permanent background grid) ----
  drawH3(id, cells, style = {}) {
    const L = this._leaflet();
    const group = L.layerGroup();
    const st = { ...this.opts.h3Style, ...style };
    for (const cell of cells) group.addLayer(L.polygon(cellToBoundary(cell), st));
    this._set(id, group);
  }

  // ---- heat: [{ h3Cell, status: red|orange|green, count }] (R1.heatmap()) ----
  drawHeatmap(id, zones, style = {}) {
    const L = this._leaflet();
    const group = L.layerGroup();
    for (const z of zones) {
      const st = { ...(HEAT_STYLE[z.status] || HEAT_STYLE.green), ...style };
      const layer = L.polygon(cellToBoundary(z.h3Cell), st);
      layer.bindPopup(`<b>Demand zone</b><br>${z.count} active order(s) · ${z.status}`);
      group.addLayer(layer);
    }
    this._set(id, group);
  }

  // ---- camera ----
  setCenter(latlng, zoom) { this.map.setView(latlng, zoom ?? this.map.getZoom()); }
  setZoom(zoom) { this.map.setZoom(zoom); }
  fitBounds(latlngs) { if (latlngs?.length) this.map.fitBounds(latlngs); }
  flyTo(latlng, zoom, opts) { this.map.flyTo(latlng, zoom, opts); }
  panTo(latlng, opts) { this.map.panTo(latlng, opts); }

  // ---- lifecycle ----
  removeLayer(id) {
    const l = this.layers.get(id);
    if (l) { l.remove(); this.layers.delete(id); }
  }
  clear() {
    for (const id of [...this.markers.keys()]) this.removeMarker(id);
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
  }

  _set(id, layer) {
    this.removeLayer(id);
    layer.addTo(this.map);
    this.layers.set(id, layer);
  }
  _leaflet() { return this.L; }
  /** Global fallback: R1Map.L = L (or pass { L } in opts). */
  static L = null;
}
