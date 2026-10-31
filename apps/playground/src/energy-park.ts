// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `?scenario=energy-park` (F648, F656): ten wind turbines whose nacelles turn into the wind and whose rotors spin
 * (`models/wind-turbine.glb`, 1,850 triangles; the `nacelle` and `rotor` nodes) behind a solar park of 720 fixed-tilt
 * tables of 24 modules (`models/solar-table.glb`, 188 triangles, facing south), south-east of Milan, as two
 * `ModelSetLayer`s. Sliders set the rotors' speed (`&rpm=` at start, 0 to 20; `&ramp=` the seconds a change takes) and
 * the direction the wind comes from (`&wind=`, degrees; the nacelles turn to face it, at `&yawSpeed=` degrees a
 * second). Without `lon` and `lat` the camera starts south of the park. Hooks in `window.vibeglobeEnergyPark`.
 */
import type { Globe } from '@vibeglobe/core';
import { createGlobeLayers, type LayerStack } from '@vibeglobe/layers';
import { ModelSetLayer } from '@vibeglobe/layers/models';

declare global {
  interface Window {
    vibeglobeEnergyPark?: { stack: LayerStack; turbines: ModelSetLayer; solar: ModelSetLayer };
  }
}

/** The park's south-west corner. */
const WEST_DEG = 9.4;
const SOUTH_DEG = 45.1;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(SOUTH_DEG * (Math.PI / 180));

/** A position `east` and `north` meters from the park's corner. */
function at(east: number, north: number): { longitudeDeg: number; latitudeDeg: number } {
  return { longitudeDeg: WEST_DEG + east / M_PER_DEG_LON, latitudeDeg: SOUTH_DEG + north / M_PER_DEG_LAT };
}

/** Adds the turbines and the solar park, then the sliders of the wind. */
export async function showEnergyPark(globe: Globe, app: HTMLElement, params: URLSearchParams): Promise<void> {
  const element = document.querySelector<HTMLElement>('#globe') ?? undefined;
  const { stack } = createGlobeLayers(globe, element ? { element } : {});
  const rpm = Math.min(20, Math.max(0, Number(params.get('rpm') ?? 15)));
  const wind = Number(params.get('wind') ?? 270);
  const base = import.meta.env.BASE_URL;
  // Two staggered rows of five, 320 m apart (4 rotor diameters) and 560 m between rows, every tower door facing south,
  // the rotors facing the wind, each turning a little faster or slower than the others, as a farm's machines do.
  const turbines = stack.add(
    new ModelSetLayer({
      id: 'turbines',
      url: `${base}models/wind-turbine.glb`,
      models: Array.from({ length: 10 }, (_, i) => ({
        id: `turbine-${String(i + 1)}`,
        position: at(200 + (i % 5) * 320 + (i >= 5 ? 160 : 0), 700 + (i >= 5 ? 560 : 0)),
        headingDeg: 180,
        yawDeg: wind - 4 + ((i * 7) % 9),
        spinRpm: rpm * (0.94 + ((i * 3) % 5) * 0.03),
        properties: { name: `Turbine ${String(i + 1)}` },
      })),
      visibleBelowMeters: 30_000,
      placeholder: { sizePx: 0 },
      yaw: { node: 'nacelle', ...(params.has('yawSpeed') ? { degPerSecond: Number(params.get('yawSpeed')) } : {}) },
      spin: { node: 'rotor', rpm, ...(params.has('ramp') ? { rampSeconds: Number(params.get('ramp')) } : {}) },
    }),
  );
  // In front of the turbines, 24 rows of 30 tables 14 m apart along a row, 10 m between rows, all facing south.
  const tables = [];
  for (let row = 0; row < 24; row++)
    for (let column = 0; column < 30; column++)
      tables.push({
        id: `table-${String(row)}-${String(column)}`,
        position: at(600 + column * 14, row * 10),
        headingDeg: 180,
      });
  const solar = stack.add(
    new ModelSetLayer({
      id: 'solar',
      url: `${base}models/solar-table.glb`,
      models: tables,
      visibleBelowMeters: 2500,
      placeholder: { color: [0.12, 0.17, 0.3], sizePx: 4 },
    }),
  );
  if (!params.has('lon')) globe.jumpTo({ ...at(820, 380), zoom: 15.6, tiltDeg: 68, headingDeg: 0 });
  await Promise.all([turbines.ready, solar.ready]);
  window.vibeglobeEnergyPark = { stack, turbines, solar };
  const panel = document.createElement('div');
  panel.id = 'energy-park-controls';
  panel.style.cssText =
    'position:absolute;top:8px;left:8px;padding:6px 10px;border-radius:6px;font:13px system-ui;' +
    'background:rgba(255,255,255,0.85);color:#222;display:grid;grid-template-columns:auto 140px 4em;gap:4px 8px';
  slider(panel, 'Rotors', { max: 20, step: 0.5, value: rpm, unit: ' rpm' }, (v) => turbines.setSpinRpm(v));
  slider(panel, 'Wind from', { max: 359, step: 1, value: wind, unit: '°' }, (v) => turbines.setYawDeg(v));
  app.append(panel);
}

/** A labelled slider from 0 to `max` that calls `change` with its value. */
function slider(
  panel: HTMLElement,
  label: string,
  { max, step, value, unit }: { max: number; step: number; value: number; unit: string },
  change: (value: number) => void,
): void {
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min: '0', max: String(max), step: String(step), value: String(value) });
  input.setAttribute('aria-label', label);
  const shown = document.createElement('span');
  const show = (): void => void (shown.textContent = `${input.value}${unit}`);
  input.addEventListener('input', () => {
    change(Number(input.value));
    show();
  });
  show();
  panel.append(label, input, shown);
}
