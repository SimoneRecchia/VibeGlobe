// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The 3D Tiles scene: the generated fixture city of `?scenario=3dtiles-city` (`public/tiles3d/`) in each of its four
 * encodings, at a chosen screen-space error, with its features picked by a click.
 */
import { watchClicks } from '@vibeglobe/controls';
import { threeTileMeshes } from '@vibeglobe/renderer/tiles3d';
import { tiles3d, type Tiles3DExtension } from '@vibeglobe/sources/tiles3d';
import dracoWasmUrl from 'draco3d/draco_decoder.wasm?url';
import { devDecoding } from '../../tiles3d-demo.js';
import type { SceneContext, SceneModule } from '../types.js';

/** Adds the city in one encoding; returns the extension and the function that removes it. */
async function addCity(
  context: SceneContext,
  encoding: string,
  sse: number,
): Promise<{ city: Tiles3DExtension; remove(): void }> {
  const draco = new URL(dracoWasmUrl, location.href).href;
  let city: Tiles3DExtension | undefined;
  const remove = context.globe.addRenderExtension(
    tiles3d(
      {
        id: `city-${encoding}`,
        url: new URL(`${import.meta.env.BASE_URL}tiles3d/city-${encoding}/tileset.json`, location.href).href,
        meshes: threeTileMeshes,
        maximumScreenSpaceError: sse,
        dracoWasmUrl: draco,
        ...(await devDecoding(draco)),
      },
      (created) => (city = created),
    ),
  );
  if (!city) throw new Error('the 3D Tiles extension was not created');
  return { city, remove };
}

/** The city's statistics, a few times a second while frames draw, and the properties of what a click picks. */
function follow(context: SceneContext, city: () => Tiles3DExtension): void {
  const stats = context.panel.readout();
  let lastMs = 0;
  context.on('frame', () => {
    const now = performance.now();
    if (now - lastMs < 250) return;
    lastMs = now;
    const s = city().stats();
    stats([
      ['Tiles drawn', String(s.drawn)],
      ['Loading', String(s.loading)],
      ['Content', `${(s.bytes / 1_048_576).toFixed(1)} of ${(s.budgetBytes / 1_048_576).toFixed(0)} MB`],
    ]);
  });
  const picked = context.panel.readout();
  context.defer(
    watchClicks(context.container, context.globe, ({ point }) => {
      const pick = city().pick(point.xPx, point.yPx);
      const rows = Object.entries(pick?.properties ?? {}).slice(0, 6);
      picked(pick ? rows.map(([key, value]) => [key, String(value)] as const) : [['Picked', 'nothing']]);
    }),
  );
}

/** The fixture city, its encoding and screen-space error, its statistics and its picked features. */
export const city: SceneModule = {
  code: `import { threeTileMeshes } from '@vibeglobe/renderer/tiles3d';
import { tiles3d } from '@vibeglobe/sources/tiles3d';

const removeCity = globe.addRenderExtension(
  tiles3d(
    { url: 'https://tiles.example.com/city/tileset.json', meshes: threeTileMeshes, maximumScreenSpaceError: 16 },
    (city) => container.addEventListener('click', (e) => console.log(city.pick(e.offsetX, e.offsetY)?.properties)),
  ),
);`,
  async start(context) {
    const { panel } = context;
    context.go({ longitudeDeg: 12.4922, latitudeDeg: 41.8902, zoom: 15.6, tiltDeg: 55, headingDeg: 30 });
    const state = { encoding: 'plain', sse: 16 };
    let shown = await addCity(context, state.encoding, state.sse);
    context.defer(() => shown.remove());
    const rebuild = async (): Promise<void> => {
      shown.remove();
      const next = await addCity(context, state.encoding, state.sse);
      if (context.signal.aborted) next.remove();
      else shown = next;
    };
    panel.choice(
      'Encoding',
      [
        ['plain', 'glTF'],
        ['draco', 'Draco'],
        ['meshopt', 'meshopt'],
        ['ktx2', 'KTX2'],
      ],
      'plain',
      (encoding) => {
        state.encoding = encoding;
        void rebuild();
      },
    );
    panel.select(
      'Screen-space error',
      [
        ['4', '4 px'],
        ['16', '16 px'],
        ['64', '64 px'],
      ],
      '16',
      (sse) => {
        state.sse = Number(sse);
        void rebuild();
      },
    );
    follow(context, () => shown.city);
    panel.note('Click a building to read its properties from the tile’s batch table.');
  },
};
