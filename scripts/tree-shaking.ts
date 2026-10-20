// Fails when importing a single export bundles modules it does not need (packages must be side-effect free).
import { relative } from 'node:path';
import { bundle } from './bundle.ts';
import { ROOT_DIR } from './workspace.ts';

const CASES = [
  { importName: 'WGS84', from: '@vibeglobe/core', needs: ['packages/core/dist/geodesy/wgs84.js'] },
  { importName: 'FrameStats', from: '@vibeglobe/core', needs: ['packages/core/dist/diagnostics/frame-stats.js'] },
  { importName: 'createDebugOverlay', from: '@vibeglobe/ui', needs: ['packages/ui/dist/debug/debug-overlay.js'] },
];

let failed = false;
for (const { importName, from, needs } of CASES) {
  const { modules } = await bundle(`import { ${importName} } from '${from}';\nconsole.log(${importName});`);
  const included = modules.filter((id) => !id.startsWith('\0')).map((id) => relative(ROOT_DIR, id));
  const unexpected = included.filter((path) => !needs.includes(path));
  const missing = needs.filter((path) => !included.includes(path));
  const ok = unexpected.length === 0 && missing.length === 0;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  import { ${importName} } from '${from}' → ${included.join(', ') || 'nothing'}`);
  if (unexpected.length > 0) console.error(`      unexpected modules: ${unexpected.join(', ')}`);
  if (missing.length > 0) console.error(`      missing modules: ${missing.join(', ')}`);
}
if (failed) process.exit(1);
