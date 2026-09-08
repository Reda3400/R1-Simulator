// R1 Vite plugin — exposes the PUBLIC R1 JS library same-origin at /__r1/*.
//
// The simulator is one consumer of R1: this plugin loads the native core,
// wraps it with `createR1` from `R1 Engine/bindings/js/r1.js` (the exact
// library external developers import), and serves it in-process. If the app
// is served, R1 is available — no second process, no port, no bridge.
//
// Endpoints: GET /__r1/health
//   POST /__r1/route|distance|matrix|nearest|corridor|match|matchOrders|heatmap
import { createRequire } from 'node:module';

import { BINDING_PATH, ENGINE_JS_LIB } from './r1-engine.mjs';

const FN = new Set([
  'route', 'distance', 'matrix', 'nearest', 'corridor', 'area', 'match', 'matchOrders', 'heatmap',
]);

function loadR1() {
  try {
    const req = createRequire(import.meta.url);
    const lib = req(ENGINE_JS_LIB); // the public library — same one devs import
    const native = req(BINDING_PATH); // the native core
    return { R1: lib.createR1(native), binding: BINDING_PATH, error: null };
  } catch (e) {
    return { R1: null, binding: BINDING_PATH, error: String(e?.message || e) };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 4e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export function r1Plugin() {
  const { R1, binding, error } = loadR1();
  if (!R1) {
    console.error(
      `\n[R1] engine unavailable (${binding})\n` +
      `     build it once: npm run r1:build   (needs cmake + C++ compiler)\n` +
      `     R1 calls will answer 503 until then.\n`);
  }
  return {
    name: 'r1-engine',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://x');
        if (!url.pathname.startsWith('/__r1/')) return next();
        res.setHeader('Content-Type', 'application/json');
        const send = (code, obj) => {
          res.statusCode = code;
          res.end(JSON.stringify(obj));
        };
        if (!R1) {
          return send(503, {
            ok: false, code: 'R1_UNAVAILABLE',
            message: `R1 engine unavailable — run: npm run r1:build (${error})`,
          });
        }
        try {
          if (url.pathname === '/__r1/health' && req.method === 'GET') {
            return send(200, { ...(await R1.health()), binding });
          }
          if (req.method !== 'POST') return send(404, { error: 'not found' });
          const fn = url.pathname.slice('/__r1/'.length);
          if (!FN.has(fn)) return send(404, { error: `unknown R1 function: ${fn}` });
          const { routing, parameters, ...body } = await readBody(req);
          const out = await R1[fn](body, { routing, parameters });
          return send(200, out);
        } catch (e) {
          const code = e?.code || 'R1_FAILED';
          const status = code === 'R1_UNAVAILABLE' ? 503 : code === 'NO_ROUTE' ? 422 : 500;
          return send(status, { ok: false, code, message: String(e?.message || e) });
        }
      });
    },
  };
}
