// The committed vector tile fixtures match their generator (ADR 0131): tiles byte for byte, and every glyph range
// and sprite sheet the styles name exists. Node only, no browser.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FONT_STACKS, OUT, RANGES } from './fixtures/generate.ts';
import { encodeTile, tileList } from './fixtures/tiles.ts';

test('the fixture tiles are what the generator writes (run e2e/vector-tiles/fixtures/generate.ts after a change)', () => {
  let tiles = 0;
  for (const { z, x, y } of tileList()) {
    const path = join(OUT, 'tiles', String(z), String(x), `${y}.pbf`);
    const expected = encodeTile(z, x, y);
    expect(existsSync(path), path).toBe(expected !== undefined);
    if (expected === undefined) continue;
    expect(Buffer.compare(readFileSync(path), Buffer.from(expected)), path).toBe(0);
    tiles++;
  }
  expect(tiles).toBeGreaterThan(100);
});

test('the glyph ranges and sprites of the fixture styles exist', () => {
  for (const [name] of FONT_STACKS)
    for (const start of RANGES) expect(existsSync(join(OUT, 'glyphs', name, `${start}-${start + 255}.pbf`))).toBe(true);
  for (const file of ['sprite.json', 'sprite.png', 'sprite@2x.json', 'sprite@2x.png'])
    expect(existsSync(join(OUT, file))).toBe(true);
});
