// `npm run dev` — starts ONLY the simulator. R1 runs inside the Vite process
// (scripts/r1-vite-plugin.mjs), so there is no second server to manage.
import { spawnSync, spawn } from 'node:child_process';

import { BINDING_PATH, BUILD_DIR, ENGINE_DIR, SIM_ROOT } from './r1-engine.mjs';

if ((await import('node:fs')).existsSync(BINDING_PATH) === false) {
  console.log('[r1] building native engine binding (one time)…');
  const cfg = spawnSync('cmake', ['-S', ENGINE_DIR, '-B', BUILD_DIR, '-DCMAKE_BUILD_TYPE=Release', '-DR1_BUILD_NODE_BINDING=ON'], { cwd: SIM_ROOT, stdio: 'inherit' });
  const bld = cfg.status === 0
    ? spawnSync('cmake', ['--build', BUILD_DIR, '--target', 'r1node', '-j8'], { cwd: SIM_ROOT, stdio: 'inherit' })
    : cfg;
  const { existsSync } = await import('node:fs');
  if (bld.status !== 0 || !existsSync(BINDING_PATH)) {
    console.error('[r1] build failed — R1 calls will answer 503. Fix cmake/C++ toolchain, then `npm run dev`.');
  }
}

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(+(process.env.VITE_PORT || 5173))], { cwd: SIM_ROOT, stdio: 'inherit' });
vite.on('exit', (c) => process.exit(c ?? 0));
process.on('SIGINT', () => vite.kill('SIGINT'));
process.on('SIGTERM', () => vite.kill('SIGTERM'));
