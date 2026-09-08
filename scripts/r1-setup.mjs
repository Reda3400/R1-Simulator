// postinstall: build the native R1 engine binding so `npm run dev` just works.
// Fails quietly (doesn't break `npm install`) — the binding is rebuilt on
// first `npm run dev` if it's still missing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { BINDING_PATH, BUILD_DIR, ENGINE_DIR, SIM_ROOT } from './r1-engine.mjs';

if (existsSync(BINDING_PATH)) { console.log('[r1] engine binding already built.'); process.exit(0); }

console.log('[r1] building native engine binding…');
const cfg = spawnSync('cmake', ['-S', ENGINE_DIR, '-B', BUILD_DIR, '-DCMAKE_BUILD_TYPE=Release', '-DR1_BUILD_NODE_BINDING=ON'], { cwd: SIM_ROOT, stdio: 'inherit' });
if (cfg.status !== 0) {
  console.warn('[r1] WARN: cmake configure failed — run `npm run dev` after installing cmake.');
  process.exit(0);
}
const bld = spawnSync('cmake', ['--build', BUILD_DIR, '--target', 'r1node', '-j8'], { cwd: SIM_ROOT, stdio: 'inherit' });
if (bld.status !== 0 || !existsSync(BINDING_PATH)) {
  console.warn('[r1] WARN: engine build failed — install cmake + a C++ compiler, then `npm run dev`.');
  process.exit(0);
}
console.log('[r1] engine binding built ✓');
