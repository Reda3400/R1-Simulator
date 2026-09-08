// Single source of truth for where the R1 engine lives.
// The simulator NEVER duplicates engine paths: everything resolves from here.
// Override: R1_ENGINE_DIR=/abs/path (or relative to the simulator root).
// Native binding override: R1_NODE_BINDING=/path/to/r1node.node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // <sim>/scripts
export const SIM_ROOT = path.resolve(here, '..');
export const ENGINE_DIR = path.resolve(SIM_ROOT, process.env.R1_ENGINE_DIR || '../R1 Engine');
export const ENGINE_JS_LIB = path.join(ENGINE_DIR, 'bindings', 'js', 'r1.js');
export const BINDING_PATH =
  process.env.R1_NODE_BINDING ||
  path.join(ENGINE_DIR, 'build', 'bindings', 'node', 'r1node.node');
export const BUILD_DIR = path.join(ENGINE_DIR, 'build');
