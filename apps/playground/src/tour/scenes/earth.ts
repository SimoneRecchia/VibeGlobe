// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The Earth chapter: the globe with demo data, space and atmosphere, the Sun and the night, the polar caps. */
import type { AtmosphereLevel } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';
import type { SceneContext, SceneModule } from '../types.js';

const DAY_MS = 86_400_000;

/** Turns the globe westward under a still camera until the visitor touches the map or turns it off. */
function rotation(context: SceneContext): (on: boolean) => void {
  let frame = 0;
  let lastMs = 0;
  const step = (timeMs: number): void => {
    if (lastMs > 0)
      context.globe.jumpTo({ longitudeDeg: context.globe.camera.longitudeDeg + (timeMs - lastMs) * 0.004 });
    lastMs = timeMs;
    frame = requestAnimationFrame(step);
  };
  const set = (on: boolean): void => {
    cancelAnimationFrame(frame);
    lastMs = 0;
    if (on) frame = requestAnimationFrame(step);
  };
  context.defer(() => set(false));
  return set;
}

/** The globe, the demo data and the controls of every corner. */
export const globeScene: SceneModule = {
  code: `import { createControls } from '@vibeglobe/controls';
import { createGlobe } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';
import { addAllControls, createUi } from '@vibeglobe/ui';

const globe = createGlobe({
  container,
  renderer: createRenderer(), // WebGPU, else WebGL2
  controls: createControls(),
  baseImageryUrl: '/vibeglobe/natural-earth-4096.jpg',
});
const ui = createUi(globe, container, { theme: 'dark' });
addAllControls(ui);`,
  async start(context) {
    const { addDemoLayers } = await import('../../showcase-data.js');
    await addDemoLayers(context.globe, context.add);
    context.go({ longitudeDeg: 10, latitudeDeg: 44, zoom: 2.2, headingDeg: 0, tiltDeg: 0 });
    const turn = rotation(context);
    const toggle = context.panel.toggle('Rotate the globe', false, turn);
    const stop = (): void => {
      toggle.checked = false;
      turn(false);
    };
    for (const type of ['pointerdown', 'wheel', 'keydown'] as const) context.container.addEventListener(type, stop);
    context.defer(() => {
      for (const type of ['pointerdown', 'wheel', 'keydown'] as const)
        context.container.removeEventListener(type, stop);
    });
    context.panel.note(
      'Search a city, switch 2D / 3D / Auto, measure, draw, save bookmarks or take a picture with the controls ' +
        'around the map. The chapters on the left show one capability each.',
    );
  },
};

/** Stars, Milky Way, halo, atmosphere, haze and fog. */
export const sky: SceneModule = {
  code: `import { addSpaceBackground } from '@vibeglobe/renderer/starfield';

const space = addSpaceBackground(globe, { glow: 1 });
space.setOptions({ milkyWay: false, brightness: 1.5 });
globe.setQualitySettings({ atmosphere: 'high', fog: true });
globe.setAtmosphere({ haze: 1.5, airlight: 0.6 });`,
  async start(context) {
    const { globe, panel } = context;
    const space = await context.hooks.space();
    const before = { ...space.options };
    const quality = globe.qualitySettings;
    const atmosphere = globe.atmosphere;
    context.defer(() => {
      space.setOptions({
        stars: before.stars,
        milkyWay: before.milkyWay,
        brightness: before.brightness,
        glow: before.glow,
      });
      globe.setQualitySettings({ atmosphere: quality.atmosphere, fog: quality.fog });
      globe.setAtmosphere({ haze: atmosphere.haze, airlight: atmosphere.airlight });
    });
    context.go({ longitudeDeg: 25, latitudeDeg: 18, zoom: 1.25, headingDeg: 0, tiltDeg: 0 });
    space.setOptions({ glow: 1 });
    const sky = panel.group('Space background');
    sky.toggle('Stars', before.stars, (stars) => space.setOptions({ stars }));
    sky.toggle('Milky Way', before.milkyWay, (milkyWay) => space.setOptions({ milkyWay }));
    sky.slider('Brightness', { min: 0, max: 4, step: 0.1, value: before.brightness }, (brightness) =>
      space.setOptions({ brightness }),
    );
    sky.slider('Halo', { min: 0, max: 4, step: 0.1, value: 1 }, (glow) => space.setOptions({ glow }));
    const air = panel.group('Atmosphere');
    const levels: AtmosphereLevel[] = ['off', 'low', 'medium', 'high', 'ultra'];
    air.choice(
      'Level',
      levels.map((l) => [l, l] as const),
      quality.atmosphere,
      (level) => globe.setQualitySettings({ atmosphere: level }),
    );
    air.toggle('Fog over the ground', quality.fog, (fog) => globe.setQualitySettings({ fog }));
    air.slider('Haze', { min: 0, max: 4, step: 0.1, value: atmosphere.haze }, (haze) => globe.setAtmosphere({ haze }));
    air.slider('Air light', { min: 0, max: 1, step: 0.05, value: atmosphere.airlight }, (airlight) =>
      globe.setAtmosphere({ airlight }),
    );
    panel.buttons(
      [
        'Down to the horizon',
        () => void globe.flyTo({ longitudeDeg: 7.1, latitudeDeg: 45.2, zoom: 13.6, tiltDeg: 80, headingDeg: 25 }),
      ],
      [
        'Back to space',
        () => void globe.flyTo({ longitudeDeg: 25, latitudeDeg: 18, zoom: 1.25, tiltDeg: 0, headingDeg: 0 }),
      ],
    );
  },
};

/** NASA's Black Marble night lights from GIBS (public domain), drawn on the night side only. */
function nightLights(context: SceneContext): (on: boolean) => void {
  const id = 'night-lights';
  const source = xyzImagery({
    id,
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
    maxLevel: 8,
    attribution: [{ text: 'NASA Black Marble (GIBS)', url: 'https://www.earthdata.nasa.gov/gibs' }],
  });
  let shown = false;
  context.defer(() => shown && context.globe.imageryLayers.remove(id));
  return (on) => {
    if (on && !shown) context.globe.imageryLayers.add({ id, sources: [source], blend: 'night', harmonize: false });
    if (!on && shown) context.globe.imageryLayers.remove(id);
    shown = on;
  };
}

/** Day and night by the Sun's position at a date and time. */
export const sun: SceneModule = {
  code: `globe.setAtmosphere({ dayNight: 1, timeMs: Date.now() }); // night side dimmed
globe.setAtmosphere({ sunLighting: true }); // or lit by the Sun

// City lights shine on the night side only.
globe.imageryLayers.add({ id: 'night-lights', sources: [lights], blend: 'night' });`,
  start(context) {
    const { globe, panel } = context;
    const before = globe.atmosphere;
    context.defer(() =>
      globe.setAtmosphere({ dayNight: before.dayNight, sunLighting: before.sunLighting, timeMs: before.timeMs }),
    );
    const now = new Date();
    const state = { day: Math.floor((Date.now() - Date.UTC(now.getUTCFullYear(), 0, 1)) / DAY_MS), hours: 18 };
    const year = Date.UTC(now.getUTCFullYear(), 0, 1);
    const apply = (): void => globe.setAtmosphere({ timeMs: year + state.day * DAY_MS + state.hours * 3_600_000 });
    globe.setAtmosphere({ dayNight: 1 });
    apply();
    context.go({ longitudeDeg: 15, latitudeDeg: 25, zoom: 1.5, headingDeg: 0, tiltDeg: 0 });
    const hour = (h: number): string =>
      `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')} UTC`;
    panel.slider('Time of day', { min: 0, max: 24, step: 0.25, value: state.hours, format: hour }, (hours) => {
      state.hours = hours;
      apply();
    });
    const date = (d: number): string =>
      new Date(year + d * DAY_MS).toLocaleDateString('en', { day: 'numeric', month: 'short' });
    panel.slider('Day of the year', { min: 0, max: 364, step: 1, value: state.day, format: date }, (day) => {
      state.day = day;
      apply();
    });
    panel.slider('Day and night', { min: 0, max: 1, step: 0.05, value: 1 }, (dayNight) =>
      globe.setAtmosphere({ dayNight }),
    );
    panel.toggle('Physical sunlight', before.sunLighting, (sunLighting) => globe.setAtmosphere({ sunLighting }));
    panel.group('Online').toggle('Night lights (NASA GIBS)', false, nightLights(context));
  },
};

/** The colors of the polar caps beyond Web Mercator. */
export const poles: SceneModule = {
  code: `createGlobe({ /* … */ polarCapColors: { north: '#0b2a4a' } });
globe.setPolarCapColors({ north: '#1d3d5f', south: '#ffffff' });`,
  start(context) {
    const { globe, panel } = context;
    const colors = { north: '#78a9cd', south: '#f2f3f7' };
    context.defer(() => globe.setPolarCapColors({ north: '#78a9cd', south: '#f2f3f7' }));
    context.go({ longitudeDeg: 10, latitudeDeg: 70, zoom: 1.5, headingDeg: 0, tiltDeg: 0 });
    panel.color('North cap', colors.north, (north) => globe.setPolarCapColors({ north }));
    panel.color('South cap', colors.south, (south) => globe.setPolarCapColors({ south }));
    panel.buttons(
      ['North pole', () => void globe.flyTo({ longitudeDeg: 10, latitudeDeg: 62, zoom: 1.45, tiltDeg: 0 })],
      ['South pole', () => void globe.flyTo({ longitudeDeg: 30, latitudeDeg: -62, zoom: 1.45, tiltDeg: 0 })],
    );
    panel.note('A geographic imagery source that covers the poles fills the caps instead.');
  },
};
