// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `?scenario=wind-farm` (F627): 2,000 copies of a light wind turbine (`models/turbine.gltf`, 84 triangles, 120 m tall)
 * on a 50 × 40 grid 500 m apart south of Milan, as one `ModelSetLayer`: the turbine within 3,000 m of the eye, a
 * placeholder beyond. `&visibleBelow=` sets the distance. Hooks in `window.vibeglobeWindFarm`.
 */
import type { Globe } from '@vibeglobe/core';
import { createGlobeLayers, type InteractionController, type LayerStack } from '@vibeglobe/layers';
import { ModelSetLayer } from '@vibeglobe/layers/models';

declare global {
  interface Window {
    vibeglobeWindFarm?: { stack: LayerStack; interaction: InteractionController | undefined; farm: ModelSetLayer };
  }
}

/** The farm's south-west corner and spacing. */
const WEST_DEG = 9.0;
const SOUTH_DEG = 45.2;
const SPACING_METERS = 500;

/** Adds the wind farm to the globe and announces it once its model has loaded. */
export async function showWindFarm(globe: Globe, params: URLSearchParams): Promise<void> {
  const element = document.querySelector<HTMLElement>('#globe') ?? undefined;
  const { stack, interaction } = createGlobeLayers(globe, element ? { element } : {});
  const models = [];
  const dLat = SPACING_METERS / 111_320;
  const dLon = SPACING_METERS / (111_320 * Math.cos(SOUTH_DEG * (Math.PI / 180)));
  for (let row = 0; row < 40; row++)
    for (let column = 0; column < 50; column++)
      models.push({
        id: `turbine-${String(row)}-${String(column)}`,
        position: { longitudeDeg: WEST_DEG + column * dLon, latitudeDeg: SOUTH_DEG + row * dLat },
        // Facing the prevailing wind from the west, each a little off.
        headingDeg: 270 + ((row * 7 + column * 3) % 20) - 10,
        properties: { row, column },
      });
  const below = params.get('visibleBelow');
  const farm = stack.add(
    new ModelSetLayer({
      id: 'wind-farm',
      url: `${import.meta.env.BASE_URL}models/turbine.gltf`,
      models,
      ...(below === null ? {} : { visibleBelowMeters: Number(below) }),
      placeholder: { color: [0.2, 0.45, 0.9], sizePx: 8 },
    }),
  );
  await farm.ready;
  window.vibeglobeWindFarm = { stack, interaction, farm };
}
