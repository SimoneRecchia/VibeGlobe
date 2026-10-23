// Generates the vector tile fixtures of the playground (ADR 0131), once, into apps/playground/public/vector-tiles/:
// the MVT pyramid (tiles.ts), the glyph ranges of the fixture font stacks (SDF glyphs drawn by the renderer's own
// rasterizer in Chromium, from the OFL-licensed Inter font installed on the machine), and the sprite sheets at 1x and
// 2x. Run: `node e2e/vector-tiles/fixtures/generate.ts` (after `npm run build`); commit the output.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import ts from 'typescript';
import { ProtoWriter } from './proto.ts';
import { encodeTile, tileList } from './tiles.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
/** Where the fixtures are written: the playground's static files. */
export const OUT = join(ROOT, 'apps/playground/public/vector-tiles');

/** Font stacks served by the fixture glyph server, with their CSS weight. */
export const FONT_STACKS: readonly (readonly [string, string])[] = [
  ['Inter Regular', '400'],
  ['Inter Bold', '700'],
];
/** Ranges served: Basic Latin and Latin-1, Latin Extended-A, Greek, Cyrillic. CJK comes from a local font. */
export const RANGES = [0, 256, 768, 1024];

function write(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function writeTiles(): number {
  let count = 0;
  for (const { z, x, y } of tileList()) {
    const bytes = encodeTile(z, x, y);
    if (bytes === undefined) continue;
    write(join(OUT, 'tiles', String(z), String(x), `${y}.pbf`), bytes);
    count++;
  }
  return count;
}

interface Glyph {
  id: number;
  bitmap: number[];
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
}

function glyphPbf(name: string, start: number, glyphs: readonly Glyph[]): Uint8Array {
  const pbf = new ProtoWriter();
  pbf.message(1, (w) => {
    w.string(1, name);
    w.string(2, `${start}-${start + 255}`);
    for (const g of glyphs) {
      w.message(3, (gw) => {
        gw.uint(1, g.id);
        if (g.bitmap.length > 0) gw.raw(2, g.bitmap);
        gw.uint(3, g.width);
        gw.uint(4, g.height);
        gw.sint(5, g.left);
        gw.sint(6, g.top);
        gw.uint(7, g.advance);
      });
    }
  });
  return pbf.finish();
}

async function writeGlyphs(): Promise<void> {
  const source = readFileSync(join(ROOT, 'packages/renderer/src/vector-tiles/local-glyphs.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const script = `${js.replace(/^export /gm, '')}\nwindow.rasterizeSdfGlyphs = rasterizeSdfGlyphs;`;
  const executablePath = process.env['VIBEGLOBE_CHROMIUM_PATH'];
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: script });
  for (const [name, weight] of FONT_STACKS) {
    for (const start of RANGES) {
      const codes = Array.from({ length: 256 }, (_, i) => start + i).filter((c) => c >= 32 && (c < 127 || c > 159));
      const glyphs = await page.evaluate(
        ([w, list]) =>
          (window as unknown as { rasterizeSdfGlyphs(w: string, f: string, c: number[]): Glyph[] }).rasterizeSdfGlyphs(
            w,
            'Inter',
            list,
          ),
        [weight, codes] as const,
      );
      // Code points the font lacks render as the fallback font's boxes or nothing: keep only Inter's coverage.
      write(join(OUT, 'glyphs', name, `${start}-${start + 255}.pbf`), glyphPbf(name, start, glyphs));
    }
  }
  await browser.close();
}

/** Sprite icons drawn procedurally: a filled shape in a color, with a white outline. */
const ICONS: readonly (readonly [string, (x: number, y: number) => boolean, [number, number, number]])[] = [
  ['dot', (x, y) => x * x + y * y <= 1, [220, 40, 40]],
  ['square', (x, y) => Math.abs(x) <= 0.8 && Math.abs(y) <= 0.8, [40, 90, 220]],
  ['triangle', (x, y) => y <= 0.8 && y >= -0.9 + 1.7 * Math.abs(x), [30, 150, 60]],
];

function writeSprites(): void {
  for (const ratio of [1, 2]) {
    const size = 16 * ratio;
    const png = new PNG({ width: size * ICONS.length, height: size });
    const index: Record<string, unknown> = {};
    ICONS.forEach(([name, inside, rgb], i) => {
      index[name] = { x: i * size, y: 0, width: size, height: size, pixelRatio: ratio };
      for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
          const x = ((px + 0.5) / size) * 2 - 1;
          const y = 1 - ((py + 0.5) / size) * 2;
          const at = (py * png.width + i * size + px) * 4;
          const fill = inside(x / 0.8, y / 0.8);
          const edge = !fill && inside(x / 0.95, y / 0.95);
          const color = fill ? rgb : [255, 255, 255];
          png.data.set([color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, fill || edge ? 255 : 0], at);
        }
      }
    });
    const suffix = ratio === 2 ? '@2x' : '';
    write(join(OUT, `sprite${suffix}.png`), PNG.sync.write(png));
    write(join(OUT, `sprite${suffix}.json`), `${JSON.stringify(index, null, 2)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  rmSync(join(OUT, 'tiles'), { recursive: true, force: true });
  rmSync(join(OUT, 'glyphs'), { recursive: true, force: true });
  console.log(`tiles: ${writeTiles()}`);
  writeSprites();
  await writeGlyphs();
  console.log('glyphs and sprites written');
}
