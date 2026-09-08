# R1 Simulator — visual test client for the R1 engine

A Vue 3 + Leaflet test bench for [R1](../README.md). It draws routes, H3 corridors,
operating zones and demand heat layers, runs scripted fleet tests, and verifies engine
behavior **before you commit**. It contains **no R1 algorithms** — every decision comes
from the engine through the same public API external developers use.

```text
npm run dev → Vite + R1 binding (in-process) → Vue app → /__r1 → R1 engine → visualization
```

---

## Quick start

```bash
npm install          # postinstall builds the native engine binding once (cmake)
npm run dev          # starts ONLY the app — R1 runs inside the Vite process
```

Open the printed `http://localhost:5173/`. There is **no second server**: R1 is served
same-origin at `/__r1`, so if the app loads, R1 is available. Probe it directly:

```bash
curl http://localhost:5173/__r1/health   # → {"ok":true,"engine":"r1-core","version":"0.1.0",…}
```

`R1_BASE` is `VITE_R1_BASE || '/__r1'` (port via `VITE_PORT`, default 5173). If the
cmake/C++ toolchain is missing, R1 calls answer `503` — fix the build, then re-run
`npm run dev`.

---

## Run a test (the NEW TEST flow)

Click **🧪 NEW TEST** and step through the setup wizard:

1. **Name the city.** Creating a new city seeds an empty simulation (a city without a
   drawn zone is compliant by default). Reusing a city clears its zone for the test —
   you redraw it.
2. **Draw the Petit operating zone.** Switch to **▰ ZONE EDGES** and draw on the map:
   - click to place polygon vertices — the surface **auto-fills with H3 hexes live**
   - **🔒 LOCK BLOB** closes the current vertex run into a ring (open runs auto-close)
   - click **inside a hex** to erase it (cell-exact exclusion that survives edits)
   - **UNDO VERTEX**, then **✓ DONE** commits the zone → the wizard auto-advances
   - (or drop to fine-grained cell editing; **SAVE** commits)
3. **Test config.** Duration, Petit/Grand fleet sizes, base fare + per-km rate, night
   multiplier (×1.25), bags fee, optional priority tiers 0–3, live order cadence, and
   on-screen speed (×5 during tests). A quick-test preset is available.
4. **▶ START.** The map centers on the drawn zone, taxis spawn **inside it** (Petits
   confined to the zone, Grands in-zone at spawn then roam the city), and a live demand
   cadence keeps orders placed **inside the zone**.

The run is **sampled every simulated minute** (`runSeries`). **✓ END TEST** (or the
timer) computes the run: created / accepted / completed / waiting / rejected /
declined coverage and revenue, and draws a **Chart.js line chart** (completions vs.
revenue, dual axes) in the results modal.

### What the sim is built to prove

- **Petits never leave the edges.** Zone confinement is enforced by the engine: free
  Petits snap back into the zone on a new patrol; dragged markers obey `dragend`
  snap-back (exercised automatically in E2E).
- **Nothing leaves the zone in a test.** Orders hail inside the drawn area; a **⛺ EDGE
  PROBE** button places probes deliberately *outside* the zone — R1 declines every
  pickup, so no fare, no leak.
- **Priorities & fares.** Tiers 0–3, night fares, bags fee and split journeys are
  rendered on orders and verified via the debug bridge.

---

## Routing modes

- **REAL ROADS (default):** the app talks OSRM through R1 (public demo endpoint, with an
  automatic fallback mirror). The app **probes the server through R1 first** and refuses
  to enter a broken mode; if the server dies mid-session it falls back to the offline
  grid automatically.
- **Offline grid:** toggled on, deterministic street grid, zero setup, no network.

Provider config lives in `src/r1client.js` (`R1_PROVIDER` — `osrmBaseUrl`,
`osrmFallbackUrl`, `profile`, `timeoutMs`). It is developer-owned and **not** an R1
default — for production, point `osrmBaseUrl` at your own OSRM instance (run one with
Docker, see `../R1 Engine/docs/providers.md`), or call `setProvider({ osrmBaseUrl })`
at runtime.

---

## Dev hooks (`window.__r1Debug`)

The app exposes a debug bridge for E2E and manual inspection:

```javascript
__r1Debug.orders()          // live order list (status/cell/route/fare/priority…)
__r1Debug.zone()            // active Petit zone cells
__r1Debug.testCfg()         // running test config
__r1Debug.runSeries()       // per-minute run sample
__r1Debug.results()         // finished-run KPIs + sanitized rides
__r1Debug.finishNow()       // end the current run
__r1Debug.dragTaxi(id, lat, lng)  // exercise the real drag→snap path
__r1Debug.h3CellOf(lat, lng), __r1Debug.ptInZone(lat, lng) …
```

---

## Tests

```bash
npm test              # unit tests: zone editor, order generator, city config (37/37)
npm run verify:r1     # engine smoke suite through the live /__r1 bridge (run `npm run dev` first)
npm run r1:test       # C++ GoogleTest suite in R1 Engine (ctest; 78/78, 1 OSRM skip w/o server)
```

Full engine API, provider docs and integration guide:
`../R1 Engine/README.md` and `../R1 Engine/docs/`.