// Prints what a browser engine shows of the playground at several views: capabilities, console messages, renderer
// counters and how much of the canvas is background. For diagnosing other engines in CI, where only logs come back.
// Usage: node scripts/browser/diagnose.ts --browser firefox|webkit|chromium (playground served on :5173).
import { chromium, firefox, webkit } from '@playwright/test';
import { PNG } from 'pngjs';
import { gpuArgs } from './gpu-args.ts';

const name = process.argv[process.argv.indexOf('--browser') + 1] ?? 'chromium';
const engine = { chromium, firefox, webkit }[name];
if (!engine) throw new Error(`Unknown browser ${name}`);
const executablePath = process.env['VIBEGLOBE_CHROMIUM_PATH'];
const browser = await engine.launch(
  name === 'firefox'
    ? { firefoxUserPrefs: { 'webgl.force-enabled': true, 'webgl.disabled': false } }
    : name === 'chromium'
      ? { args: gpuArgs(), ...(executablePath ? { executablePath } : {}) }
      : {},
);
const VIEWS = [
  'zoom=3',
  'lon=15&lat=40&zoom=6',
  'lon=12.5&lat=41.9&zoom=10',
  'lon=12.5&lat=41.9&zoom=14',
  'lon=9.19&lat=45.46&zoom=20',
];
try {
  for (const view of VIEWS) {
    const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
    const messages: string[] = [];
    page.on('console', (m) => messages.push(`${m.type()}: ${m.text().slice(0, 200)}`));
    page.on('pageerror', (e) => messages.push(`pageerror: ${e.message.slice(0, 200)}`));
    await page.goto(`http://localhost:5173/?backend=webgl2&${view}`);
    await page.waitForFunction(() => window.vibeglobePlayground !== undefined);
    const info = await page.evaluate(async () => {
      const globe = window.vibeglobePlayground?.globe;
      if (!globe) return { error: 'no globe' };
      try {
        await globe.ready;
      } catch (error) {
        return { error: String(error) };
      }
      await new Promise((r) => setTimeout(r, 3000));
      const gl = document.createElement('canvas').getContext('webgl2');
      return {
        caps: globe.capabilities,
        camera: globe.camera,
        stats: globe.rendererStats(),
        resources: globe.resourceCounts(),
        frames: globe.frameNumber,
        clipControl: gl?.getExtension('EXT_clip_control') != null,
        floatBuffer: gl?.getExtension('EXT_color_buffer_float') != null,
        canvas: (() => {
          const c = document.querySelector('canvas');
          return c ? { width: c.width, height: c.height, cssWidth: c.clientWidth } : undefined;
        })(),
      };
    });
    const png = PNG.sync.read(await page.locator('#globe').screenshot());
    const counts = new Map<string, number>();
    for (let i = 0; i < png.data.length; i += 4) {
      const key = [png.data[i], png.data[i + 1], png.data[i + 2]].map((v) => Math.round((v ?? 0) / 32)).join(',');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4);
    console.log(
      `DIAG ${name} ${view}\n  ${JSON.stringify(info)}\n  colors(÷32): ${JSON.stringify(top)}\n  ${messages.slice(0, 12).join('\n  ')}`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
