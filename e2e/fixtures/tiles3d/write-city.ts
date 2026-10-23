/**
 * Writes the fixture city's variants (`city.ts`) to `apps/playground/public/tiles3d/city-<variant>/`, where the
 * playground's `3dtiles-city` scenario serves them: `node e2e/fixtures/tiles3d/write-city.ts`.
 * The KTX2 variant's ground texture is a 64 × 64 checker encoded with the fixture server's Basis encoder (ETC1S).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeKtx2 } from '../../../scripts/fixtures/tiles/ktx2.ts';
import { cityFiles, type CityVariant } from './city.ts';

const OUT = fileURLToPath(new URL('../../../apps/playground/public/tiles3d/', import.meta.url));

function checker(sizePx: number): Uint8Array {
  const rgba = new Uint8Array(sizePx * sizePx * 4);
  for (let y = 0; y < sizePx; y++)
    for (let x = 0; x < sizePx; x++) {
      const on = ((x >> 3) + (y >> 3)) % 2 === 0;
      rgba.set(on ? [150, 160, 140, 255] : [110, 120, 100, 255], (y * sizePx + x) * 4);
    }
  return rgba;
}

const ktx2 = new Uint8Array(await encodeKtx2(checker(64), 64, 64, 'etc1s'));
for (const variant of ['plain', 'draco', 'meshopt', 'ktx2', 'terrain'] as const satisfies readonly CityVariant[]) {
  const dir = join(OUT, `city-${variant}`);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, bytes] of await cityFiles(variant, ktx2)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  console.log(`wrote ${dir}`);
}
