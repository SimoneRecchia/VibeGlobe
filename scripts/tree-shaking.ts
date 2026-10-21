// Fails when importing a single export bundles modules it does not need (packages must be side-effect free).
import { relative } from 'node:path';
import { bundle } from './bundle.ts';
import { ROOT_DIR } from './workspace.ts';

const CASES = [
  { importName: 'WGS84', from: '@vibeglobe/core', needs: ['packages/core/dist/geodesy/wgs84.js'] },
  { importName: 'FrameStats', from: '@vibeglobe/core', needs: ['packages/core/dist/diagnostics/frame-stats.js'] },
  {
    importName: 'createDebugOverlay',
    from: '@vibeglobe/ui',
    // The panel is styled by the ui stylesheet's theme variables (F429), which it installs.
    needs: [
      'packages/ui/dist/debug/debug-overlay.js',
      'packages/ui/dist/theme/install.js',
      'packages/ui/dist/theme/styles.js',
    ],
  },
  // The UI layer pulls in no control the application does not add.
  {
    importName: 'createUi',
    from: '@vibeglobe/ui',
    needs: [
      'packages/ui/dist/ui.js',
      'packages/ui/dist/i18n/translator.js',
      'packages/ui/dist/i18n/en.js',
      'packages/ui/dist/i18n/it.js',
      'packages/ui/dist/theme/install.js',
      'packages/ui/dist/theme/styles.js',
    ],
  },
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
