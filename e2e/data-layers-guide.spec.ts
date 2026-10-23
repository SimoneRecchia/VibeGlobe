// The data layers guide's examples run as tests (F386): every `ts` block of docs/guides/data-layers.md runs in the
// playground with `globe` defined, and draws what it describes.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import ts from 'typescript';
import { openGlobe, waitForIdle } from './support/globe.ts';

const GUIDE = readFileSync('docs/guides/data-layers.md', 'utf8');
const EXAMPLES = [...GUIDE.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');

/** Turns `import { a, b } from '@vibeglobe/x';` into reads of the page's module table, and the TypeScript into JavaScript. */
function runnable(code: string): string {
  const imports = code.replace(/import \{([^}]+)\} from '(@vibeglobe\/[\w/-]+)';/g, "const {$1} = __modules['$2'];");
  return ts.transpileModule(imports, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}

test('the data layers guide covers every topic with an example, and every example runs and draws (F386)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  for (const heading of [
    '## Primitives',
    '## Placement',
    '## Styling',
    '## Clustering',
    '## Labels',
    '## Picking, events and selection',
    '## Live updates and fitting the view',
  ])
    expect(GUIDE).toContain(heading);
  expect(EXAMPLES.length).toBeGreaterThanOrEqual(7);
  await openGlobe(page, 'backend=webgl2&lon=12.5&lat=42&zoom=5');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const [index, example] of EXAMPLES.entries()) {
    const before = await page.evaluate(() => window.vibeglobePlayground?.globe.layerTarget()?.stats?.().rebuilds ?? 0);
    const outcome = await page.evaluate(async (code) => {
      // Vite serves a workspace package by its module id.
      const prefix = '/@id/@vibeglobe/';
      const modules = {
        '@vibeglobe/layers': (await import(/* @vite-ignore */ `${prefix}layers`)) as unknown,
        '@vibeglobe/core': (await import(/* @vite-ignore */ `${prefix}core`)) as unknown,
      };
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
        ...args: string[]
      ) => (modules: unknown, globe: unknown) => Promise<void>;
      try {
        await new AsyncFunction('__modules', 'globe', code)(modules, window.vibeglobePlayground?.globe);
        return 'ok';
      } catch (error) {
        return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
    }, runnable(example));
    expect(outcome, `example ${index + 1}`).toBe('ok');
    await page.waitForTimeout(300);
    await waitForIdle(page);
    // It drew: a new batch for its layers.
    const after = await page.evaluate(() => window.vibeglobePlayground?.globe.layerTarget()?.stats?.().rebuilds ?? 0);
    expect(after, `example ${index + 1} draws`).toBeGreaterThan(before);
  }
  expect(errors).toEqual([]);
});
