// City configuration: city CRUD + per-service operating areas.
// The simulator owns city concepts (name, services, H3 area) — R1 itself
// stays a generic engine and only ever receives {service, operating_area}.
//
// Storage shape for an operating area (matches the R1 binding):
//   { service: 'petit_taxi'|'grand_taxi', h3_resolution: 9, allowed_cells: [ ... ] }
// Cells are the source of truth — never converted to polygons for storage.
//
// Areas are stored ON the city object (`city.areas[service]`) so that Vue
// reactivity (the `cities` ref proxies these plain objects) invalidates
// computed state the moment an area is saved/cleared.
import { CITIES } from './r1client.js';

export const H3_RES = 9;

export const SERVICES = ['petit_taxi', 'grand_taxi'];

/// Grand Taxi has NO H3 operating area (license boundary only applies to
/// Petit Taxis). `null` area === unrestricted, and is never coerced into the
/// petit set — the service distinction stays explicit.
export function grandTaxiArea() {
  return null;
}

function freshArea(service) {
  return { service, h3_resolution: H3_RES, allowed_cells: [] };
}

export function defaultCities() {
  // Deliberately empty: the app boots into the SETUP wizard and asks for the
  // operating city's name first. Zero pre-seeded defaults.
  return [];
}

export function createCity(opts = {}) {
  const id = opts.city_id || `city_${Date.now()}`;
  return {
    city_id: id,
    city_name: opts.city_name || 'Untitled City',
    services: { petit_taxi: opts.petit_taxi ?? true, grand_taxi: opts.grand_taxi ?? false },
    center: opts.center || null,
    bbox: opts.bbox || null,
    areas: { petit_taxi: freshArea('petit_taxi') },
  };
}

/// Serialize city config WITH its H3 areas so one JSON round-trips the whole world.
export function toJSON(city) {
  const area = (city.areas || {})[SERVICES[0]];
  return {
    city_id: city.city_id,
    city_name: city.city_name,
    services: { ...city.services },
    center: city.center,
    bbox: city.bbox,
    operating_areas: {
      petit_taxi: area ? { ...area, allowed_cells: [...area.allowed_cells] } : null,
      grand_taxi: null,
    },
  };
}

export function fromJSON(obj) {
  const city = createCity({
    city_id: obj.city_id,
    city_name: obj.city_name,
    petit_taxi: !!obj.services?.petit_taxi,
    grand_taxi: !!obj.services?.grand_taxi,
  });
  city.center = obj.center || null;
  city.bbox = obj.bbox || null;
  const area = obj.operating_areas?.petit_taxi;
  if (area && Array.isArray(area.allowed_cells)) {
    setArea(city, 'petit_taxi', {
      h3_resolution: area.h3_resolution || H3_RES,
      allowed_cells: [...area.allowed_cells],
    });
  }
  return city;
}

/// Save the H3 area for a service on a city. Grand always stays null.
/// Returns the area so callers can immediately re-use it for matching/generation.
export function setArea(city, service, area) {
  if (service === 'grand_taxi') return null;
  city.areas = city.areas || {};
  city.areas[service] = {
    h3_resolution: area?.h3_resolution || H3_RES,
    service: 'petit_taxi',
    allowed_cells: Array.isArray(area?.allowed_cells) ? [...area.allowed_cells] : [],
  };
  return city.areas[service];
}

/// Get the R1 `operating_area` argument for a service: petit → area object,
/// grand → null (unrestricted). Returns {} when petit has no saved area yet.
export function operatingAreaArg(city, service) {
  if (service === 'grand_taxi') return null;
  const area = (city.areas || {})[service];
  if (!area || !area.allowed_cells.length) return {};
  return { h3_resolution: area.h3_resolution || H3_RES, cells: [...area.allowed_cells] };
}

export function areaCells(city, service) {
  if (service === 'grand_taxi') return [];
  const area = (city.areas || {})[service];
  return area ? [...area.allowed_cells] : [];
}

export function serviceEnabled(city, service) {
  return !!(city.services && city.services[service]);
}