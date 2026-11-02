// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The Models chapter's model scenes: the energy park of the `energy-park` scenario (turbines with turning nacelles and
 * spinning rotors, solar tables) with a model to drag, and the 2,000 instanced turbines of `wind-farm`.
 */
import { fitObjects } from '@vibeglobe/layers';
import { ModelLayer, type ModelSetLayer } from '@vibeglobe/layers/models';
import { energyParkLayers } from '../../energy-park.js';
import { windFarmLayer } from '../../wind-farm.js';
import type { SceneContext, SceneModule } from '../types.js';
import { freeTilt } from './tilt.js';

const BASE = import.meta.env.BASE_URL;

/** Attaches selection by click to model layers, showing the selected copy's properties in one readout. */
function selection(
  context: SceneContext,
  describe: (properties: Readonly<Record<string, unknown>>) => string,
): (layer: ModelSetLayer | ModelLayer) => void {
  const readout = context.panel.readout();
  const { interaction } = context.layers;
  context.defer(() => interaction.clearSelection());
  return (layer) =>
    void layer.on('click', ({ feature }) => {
      interaction.clearSelection();
      interaction.select(feature.layerId, feature.id);
      readout([['Selected', describe(feature.properties)]]);
    });
}

/** A pyramid that the pointer drags over the ground. */
function draggablePyramid(context: SceneContext): void {
  const pyramid = context.add(
    new ModelLayer({
      id: 'park-pyramid',
      models: [
        {
          id: 'pyramid',
          url: `${BASE}models/pyramid.gltf`,
          position: { longitudeDeg: 9.4095, latitudeDeg: 45.1045 },
          scale: 25,
        },
      ],
      draggable: true,
    }),
  );
  const readout = context.panel.readout();
  pyramid.on('drag-end', () => {
    const at = pyramid.getPosition('pyramid');
    if (at) readout([['Pyramid', `${at.latitudeDeg.toFixed(5)}°, ${at.longitudeDeg.toFixed(5)}°`]]);
  });
}

/** Ten turbines and 720 solar tables, with the wind's sliders. */
export const energyPark: SceneModule = {
  code: `import { ModelSetLayer } from '@vibeglobe/layers/models';

const farm = stack.add(new ModelSetLayer({
  url: '/models/wind-turbine.glb',
  models: turbines, // [{ id, position, headingDeg, yawDeg, spinRpm }]
  yaw: { node: 'nacelle', degPerSecond: 6 }, // turns into the wind
  spin: { node: 'rotor', rampSeconds: 4 },
}));
farm.setSpinRpm(12);
farm.setYawDeg(225);
await fitObjects(globe, farm.framePositions(), { paddingPx: 40, tiltDeg: 45 });`,
  async start(context) {
    const { globe, panel } = context;
    const { turbines, solar } = energyParkLayers(BASE, { rpm: 14, wind: 270 });
    context.add(turbines);
    context.add(solar);
    // From the south-west, the solar tables in front of the turbines.
    context.go({ longitudeDeg: 9.4105, latitudeDeg: 45.1035, zoom: 16.1, tiltDeg: 73, headingDeg: 18 });
    panel.slider('Rotors', { min: 0, max: 20, step: 0.5, value: 14, format: (v) => `${String(v)} rpm` }, (v) =>
      turbines.setSpinRpm(v),
    );
    panel.slider('Wind from', { min: 0, max: 359, step: 1, value: 270, format: (v) => `${String(v)}°` }, (v) =>
      turbines.setYawDeg(v),
    );
    panel.buttons(
      [
        'Frame the park',
        () =>
          void fitObjects(globe, [...turbines.framePositions(), ...solar.framePositions()], {
            paddingPx: 40,
            tiltDeg: 45,
          }),
      ],
      ['Frame a turbine', () => void fitObjects(globe, turbines.framePositions(['turbine-3']), { paddingPx: 40 })],
    );
    selection(context, (properties) => String(properties['name'] ?? 'a turbine'))(turbines);
    draggablePyramid(context);
    panel.note('Click a turbine to select it; drag the pyramid. The rotors spin only while a turbine is in view.');
    await Promise.all([turbines.ready, solar.ready]);
  },
};

/** 2,000 copies of one turbine, a placeholder beyond a distance. */
export const instancing: SceneModule = {
  code: `const farm = stack.add(new ModelSetLayer({
  url: '/models/turbine.gltf', // 84 triangles
  models: turbines, // 2,000 copies: one instanced draw per mesh
  visibleBelowMeters: 3000, // farther copies are placeholders
  placeholder: { color: [0.2, 0.45, 0.9], sizePx: 8 },
}));`,
  async start(context) {
    const { panel, layers } = context;
    freeTilt(context);
    context.go({ longitudeDeg: 9.15, latitudeDeg: 45.255, zoom: 14.6, tiltDeg: 74, headingDeg: 40 });
    let farm = context.add(windFarmLayer(BASE));
    const select = selection(context, (p) => `row ${String(p['row'])}, column ${String(p['column'])}`);
    select(farm);
    panel.select(
      'Model nearer than',
      [
        ['1000', '1 km'],
        ['3000', '3 km'],
        ['10000', '10 km'],
        ['30000', '30 km'],
      ],
      '3000',
      (meters) => {
        layers.stack.remove(farm);
        farm = context.add(windFarmLayer(BASE, Number(meters)));
        select(farm);
      },
    );
    panel.note('2,000 turbines 500 m apart: each mesh is one draw for every copy in view.');
    await farm.ready;
  },
};
