// R1 smoke test: exercises the exact in-process endpoints the Vue app uses.
// Usage: npm run verify:r1   (dev server must run: npm run dev)
const BASE = process.env.R1_BASE || 'http://127.0.0.1:5173/__r1';
const rows = [];
const check = (name, cond, detail = '') => rows.push({ name, ok: !!cond, detail });

const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ routing: 'mock', ...b }) });
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
};

const A = [33.59, -7.63];
const U1 = { id: 'U1', pickup: [33.591, -7.628], dropoff: [33.5962, -7.5888] };
const U2 = { id: 'U2', pickup: [33.592, -7.62], dropoff: [33.598, -7.595] };
const U4 = { id: 'U4', pickup: [33.586, -7.645], dropoff: [33.5805, -7.6166] };
const P = { h3Resolution: 9, hexWidth: 2, maxDetourRatio: 1.3, directionCheck: true };
const driver = { id: 'T01', pos: A, heading: 90, capacityLimit: 3, occupancy: 0, stops: [] };

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
check('bridge health', !!health?.ok, JSON.stringify(health));

const route = await post('/route', { start: A, destination: U1.dropoff, parameters: P });
check('route geometry + corridor', route.geometry.length > 10 && route.corridor.length > route.h3Path.length,
  `${route.geometry.length}pts ${route.distance.toFixed(0)}m ${route.corridor.length}hex`);

const dec = await post('/match', { driver, route: [], order: U1, parameters: P });
check('decider U1 compatible', dec.compatible && dec.decider, dec.reasonText);

const pool = await post('/match', {
  driver: { ...driver, stops: [
    { type: 'pickup', orderId: 'U1', pt: U1.pickup, slots: 1 },
    { type: 'dropoff', orderId: 'U1', pt: U1.dropoff, slots: 1 },
  ] },
  route: route.geometry, order: U2, parameters: P,
});
check('pool U2 compatible', pool.compatible, `detour ${pool.detourRatio}`);
check('pool insertion ordered', pool.insertion.pickupIndex <= pool.insertion.dropoffIndex);

const back = await post('/match', {
  driver: { ...driver, stops: [
    { type: 'pickup', orderId: 'U1', pt: U1.pickup, slots: 1 },
    { type: 'dropoff', orderId: 'U1', pt: U1.dropoff, slots: 1 },
  ] },
  route: route.geometry, order: U4, parameters: P,
});
check('backtrack U4 rejected', !back.compatible, back.reason);

const auc = await post('/matchOrders', {
  drivers: [driver], orders: [U1, U2, U4], waited: [0, 0, 0], heatAfterS: 300, parameters: P,
});
const got = auc.assignments.map((a) => a.orderId).sort();
check('auction assigns U1+U2', JSON.stringify(got) === '["U1","U2"]', got.join(','));
check('auction leaves U4', JSON.stringify(auc.unassigned) === '["U4"]', auc.unassigned.join(','));

const now = 1700000000;
const heat = await post('/heatmap', {
  orders: Array.from({ length: 6 }, () => ({ pickup: [33.589, -7.62], placedAt: now - 60 })),
  now, resolution: 8,
});
check('heatmap red@6', heat[0]?.status === 'red', `${heat[0]?.status} x${heat[0]?.count}`);

let fail = 0;
console.log('\nR1 bridge smoke (what the Vue app calls)\n');
for (const r of rows) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `   ${r.detail}` : ''}`); if (!r.ok) fail++; }
console.log(`\n${rows.length - fail}/${rows.length} checks passed\n`);
process.exit(fail ? 1 : 0);
