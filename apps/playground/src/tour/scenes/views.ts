// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The Views chapter: view modes and the morph, navigation and the tilt policy, camera movements, camera limits. */
import type { CameraMovement, ViewInit } from '@vibeglobe/core';
import type { SceneModule } from '../types.js';
import { TILT_POLICY } from './tilt.js';

const ROME: ViewInit = { longitudeDeg: 12.4823, latitudeDeg: 41.8958, zoom: 16.2, headingDeg: 20 };
const km = (meters: number): string =>
  meters >= 10_000
    ? `${Math.round(meters / 1000).toLocaleString('en')} km`
    : `${Math.round(meters).toLocaleString('en')} m`;

/** 2D, 3D and Auto, and the globe flattening into the map. */
export const viewModes: SceneModule = {
  code: `globe.setViewMode('auto'); // or '2d', '3d'
globe.on('camera-change', ({ phase, morphFactor, tiltDeg }) => {
  console.log(phase, morphFactor, tiltDeg); // 'globe' → 'flattening' → '2d' / '3d'
});
await globe.flyTo({ longitudeDeg: 12.48, latitudeDeg: 41.9, zoom: 16 });`,
  start(context) {
    const { globe, panel } = context;
    context.go({ longitudeDeg: 12, latitudeDeg: 42, zoom: 2.4, headingDeg: 0, tiltDeg: 0 });
    const mode = (): '2d' | '3d' | 'auto' => (globe.viewMode === 'manual' ? '3d' : globe.viewMode);
    const show = panel.choice(
      'View mode',
      [
        ['2d', '2D'],
        ['3d', '3D'],
        ['auto', 'Auto'],
      ],
      mode(),
      (next) => globe.setViewMode(next),
    );
    context.on('view-mode-change', () => show(mode()));
    panel.buttons(
      ['From orbit to the street', () => void globe.flyTo(ROME, { durationMs: 6000 })],
      ['Back to the globe', () => void globe.resetToGlobe()],
    );
    const readout = panel.readout();
    const update = (): void => {
      const camera = globe.camera;
      readout([
        ['Phase', camera.phase],
        ['Globe → map', `${Math.round(camera.morphFactor * 100)} % flat`],
        ['Zoom', camera.zoom.toFixed(2)],
        ['Tilt', `${camera.tiltDeg.toFixed(1)}°`],
        ['Eye distance', km(camera.rangeMeters)],
      ]);
    };
    context.on('camera-change', update);
    update();
  },
};

/** Navigation modes and the tilt policy. */
export const navigation: SceneModule = {
  code: `import { createControls } from '@vibeglobe/controls';

const controls = createControls({ navigationMode: 'north-up', tiltPolicy: true });
controls.setTiltPolicy({ lock2DAboveMeters: 100_000, fullTiltBelowMeters: 5_000 });
controls.onTiltAvailabilityChange((available) => (button3d.disabled = !available));`,
  start(context) {
    const { globe, panel, navigation: controls } = context;
    context.go({ longitudeDeg: 9.8, latitudeDeg: 46.1, zoom: 5, headingDeg: 0, tiltDeg: 0 });
    if (!controls) return void panel.note('This page runs without navigation controls.');
    const mode = controls.navigationMode;
    context.defer(() => {
      controls.setNavigationMode(mode);
      controls.setTiltPolicy(TILT_POLICY);
    });
    panel.choice(
      'A drag',
      [
        ['free', 'Turns like a trackball'],
        ['north-up', 'Keeps north up'],
      ],
      mode,
      (next) => controls.setNavigationMode(next),
    );
    const policy = { lock2DAboveMeters: 20_000, autoTiltMaxDeg: 60 };
    const group = panel.group('Tilt policy');
    group.toggle('Tie the tilt to the distance', TILT_POLICY, (on) => controls.setTiltPolicy(on ? policy : false));
    // A logarithmic slider from 2 km to 3,000 km.
    const lockKm = (v: number): number => 2 * 1500 ** (v / 100);
    const lockFormat = (v: number): string => km(lockKm(v) * 1000);
    group.slider('Flat beyond', { min: 0, max: 100, step: 1, value: 31, format: lockFormat }, (v) => {
      policy.lock2DAboveMeters = lockKm(v) * 1000;
      controls.setTiltPolicy(policy);
    });
    group.slider('Automatic tilt', { min: 0, max: 80, step: 1, value: 60, format: (v) => `${String(v)}°` }, (v) => {
      policy.autoTiltMaxDeg = v;
      controls.setTiltPolicy(policy);
    });
    const readout = group.readout();
    const update = (): void =>
      readout([
        ['Tilt allowed', controls.tiltAvailable ? 'yes' : 'no, too far'],
        ['Largest tilt now', `${controls.maxTiltDeg.toFixed(0)}°`],
        ['Eye distance', km(globe.camera.rangeMeters)],
      ]);
    context.on('camera-change', update);
    context.defer(controls.onTiltAvailabilityChange(update));
    update();
    panel.note(
      'Drag to pan, right-drag or Ctrl+drag to turn and tilt, Shift+drag to zoom to a box; the Help button lists every gesture.',
    );
  },
};

/** Fly, ease, fit, tour and orbit. */
export const camera: SceneModule = {
  code: `await globe.flyTo({ longitudeDeg: 139.69, latitudeDeg: 35.69, zoom: 11 });
await globe.fitBounds({ westDeg: 6.6, southDeg: 36.6, eastDeg: 18.5, northDeg: 47.1 }, { paddingPx: 40 });
const tour = globe.tour([
  { target: { longitudeDeg: 2.35, latitudeDeg: 48.86, zoom: 12 }, dwellMs: 1500 },
  { target: { longitudeDeg: 12.49, latitudeDeg: 41.89, zoom: 13, tiltDeg: 50 } },
]);
tour.cancel(); // or any input interrupts it
globe.orbit({ degreesPerSecond: 10 });`,
  start(context) {
    const { globe, panel, signal } = context;
    context.go({ longitudeDeg: 12, latitudeDeg: 30, zoom: 1.8, headingDeg: 0, tiltDeg: 0 });
    const readout = panel.readout();
    const follow = (name: string, movement: CameraMovement): void => {
      readout([[name, 'moving…']]);
      void movement.then((outcome) => readout([[name, outcome]]));
    };
    const places: Record<string, ViewInit> = {
      Tokyo: { longitudeDeg: 139.69, latitudeDeg: 35.69, zoom: 11 },
      'New York': { longitudeDeg: -74.006, latitudeDeg: 40.713, zoom: 11.5 },
      'Rio de Janeiro': { longitudeDeg: -43.2, latitudeDeg: -22.95, zoom: 11 },
      'Cape Town': { longitudeDeg: 18.42, latitudeDeg: -33.93, zoom: 11 },
    };
    let place = 'Tokyo';
    panel.select(
      'Destination',
      Object.keys(places).map((p) => [p, p] as const),
      place,
      (next) => (place = next),
    );
    panel.buttons(
      ['Fly', () => follow('Flight', globe.flyTo(places[place] ?? {}, { signal }))],
      ['Ease', () => follow('Ease', globe.easeTo(places[place] ?? {}, { signal }))],
      [
        'Fit Italy',
        () =>
          follow(
            'Fit',
            globe.fitBounds({ westDeg: 6.6, southDeg: 36.6, eastDeg: 18.5, northDeg: 47.1 }, { paddingPx: 40, signal }),
          ),
      ],
    );
    panel.buttons(
      ['Tour of Europe', () => follow('Tour', globe.tour(EUROPE_TOUR, { signal }))],
      ['Orbit', () => follow('Orbit', globe.orbit({ degreesPerSecond: 12, signal }))],
    );
    panel.buttons(
      ['North up', () => follow('Rotation', globe.rotateTo(0, { signal }))],
      ['Tilt 60°', () => follow('Tilt', globe.tiltTo(60, { signal }))],
      ['Whole globe', () => follow('Reset', globe.resetToGlobe({ signal }))],
    );
    panel.note('Any drag, wheel or key interrupts a movement; leaving the scene cancels it.');
  },
};

/** The tour of the camera scene: three cities, tilted, with a pause at each. */
const EUROPE_TOUR = [
  { target: { longitudeDeg: 2.2945, latitudeDeg: 48.8584, zoom: 15, tiltDeg: 55, headingDeg: 300 }, dwellMs: 1200 },
  { target: { longitudeDeg: 12.4922, latitudeDeg: 41.8902, zoom: 15.5, tiltDeg: 55, headingDeg: 20 }, dwellMs: 1200 },
  { target: { longitudeDeg: 13.3777, latitudeDeg: 52.5163, zoom: 15, tiltDeg: 55, headingDeg: 90 }, dwellMs: 1200 },
  { target: { longitudeDeg: 10, latitudeDeg: 47, zoom: 4.5, tiltDeg: 0, headingDeg: 0 } },
];

/** Bounds, zoom range and largest tilt. */
export const limits: SceneModule = {
  code: `globe.setConstraints({
  bounds: { westDeg: 6.6, southDeg: 36.6, eastDeg: 18.5, northDeg: 47.1 },
  minZoom: 5,
  maxZoom: 14,
  maxTiltDeg: 45,
});
globe.setConstraints({}); // no limits`,
  start(context) {
    const { globe, panel } = context;
    const before = globe.constraints;
    context.defer(() => globe.setConstraints(before));
    context.go({ longitudeDeg: 12.5, latitudeDeg: 42, zoom: 5.4, headingDeg: 0, tiltDeg: 0 });
    const limits = { bounded: true, minZoom: 4, maxZoom: 14, maxTiltDeg: 45 };
    const apply = (): void =>
      globe.setConstraints({
        ...(limits.bounded ? { bounds: { westDeg: 6.6, southDeg: 36.6, eastDeg: 18.5, northDeg: 47.1 } } : {}),
        minZoom: limits.minZoom,
        maxZoom: limits.maxZoom,
        maxTiltDeg: limits.maxTiltDeg,
      });
    apply();
    panel.toggle('Keep the center over Italy', true, (on) => ((limits.bounded = on), apply()));
    const zoom = (v: number): string => v.toFixed(1);
    panel.slider('Farthest zoom', { min: 0, max: 10, step: 0.5, value: limits.minZoom, format: zoom }, (v) => {
      limits.minZoom = Math.min(v, limits.maxZoom);
      apply();
    });
    panel.slider('Nearest zoom', { min: 6, max: 22, step: 0.5, value: limits.maxZoom, format: zoom }, (v) => {
      limits.maxZoom = Math.max(v, limits.minZoom);
      apply();
    });
    panel.slider('Largest tilt', { min: 0, max: 89, step: 1, value: 45, format: (v) => `${String(v)}°` }, (v) => {
      limits.maxTiltDeg = v;
      apply();
    });
    panel.note('Try to drag away from Italy or zoom out: every gesture and flight stops at the limits.');
  },
};
