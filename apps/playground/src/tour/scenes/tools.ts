// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The Tools chapter: geodesic measurement, coordinates and grids, the view in the address and pictures of it. */
import { watchClicks } from '@vibeglobe/controls';
import {
  formatArea,
  formatCoordinate,
  formatLength,
  gridLines,
  measureArea,
  measureDistance,
  parseCoordinateResult,
  transformCoordinates,
  viewStateOf,
  viewStateToUrl,
  type LonLat,
} from '@vibeglobe/gis';
import { DataLayer, type Feature } from '@vibeglobe/layers';
import { captureView } from '@vibeglobe/ui';
import { element } from '../panel.js';
import type { SceneContext, SceneModule } from '../types.js';

const RAD = Math.PI / 180;
const lineOf = (id: string, coordinates: number[][]): Feature => ({
  type: 'Feature',
  id,
  properties: {},
  geometry: { type: 'LineString', coordinates },
});
const pair = (p: LonLat): number[] => [p.longitudeDeg, p.latitudeDeg];

/** Points along the great circle from `a` to `b`: on a sphere, close enough to draw the ellipsoid's geodesic. */
function greatCircle(a: LonLat, b: LonLat, steps = 64): number[][] {
  const unit = (p: LonLat): number[] => [
    Math.cos(p.latitudeDeg * RAD) * Math.cos(p.longitudeDeg * RAD),
    Math.cos(p.latitudeDeg * RAD) * Math.sin(p.longitudeDeg * RAD),
    Math.sin(p.latitudeDeg * RAD),
  ];
  const [p, q] = [unit(a), unit(b)];
  const angle = Math.acos(
    Math.min(
      1,
      p.reduce((sum, x, i) => sum + x * (q[i] ?? 0), 0),
    ),
  );
  return Array.from({ length: steps + 1 }, (_, i) => {
    const s = Math.sin((1 - i / steps) * angle) / Math.sin(angle);
    const u = Math.sin((i / steps) * angle) / Math.sin(angle);
    const [x = 0, y = 0, z = 0] = p.map((pi, k) => s * pi + u * (q[k] ?? 0));
    return [Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD];
  });
}

const MILAN = { longitudeDeg: 9.19, latitudeDeg: 45.4642 };
const ROME = { longitudeDeg: 12.4964, latitudeDeg: 41.9028 };
const VENICE = { longitudeDeg: 12.3155, latitudeDeg: 45.4408 };
const NEW_YORK = { longitudeDeg: -74.006, latitudeDeg: 40.7128 };

/** Distances and areas on the WGS84 ellipsoid, beside the Draw and Measure tools. */
export const measure: SceneModule = {
  code: `import { formatLength, measureArea, measureDistance } from '@vibeglobe/gis';

const { distanceMeters, initialBearingDeg } = measureDistance(milan, rome); // Karney's geodesics
formatLength(distanceMeters); // '477 km'
measureArea([milan, rome, venice]).areaSquareMeters;`,
  start(context) {
    const { panel } = context;
    context.go({ longitudeDeg: -20, latitudeDeg: 45, zoom: 2.4, tiltDeg: 0, headingDeg: 0 });
    const lines = context.add(
      new DataLayer('polyline', { id: 'measure-lines', style: { 'line-color': '#ff3d00', 'line-width': 3 } }),
    );
    const ids: string[] = [];
    const draw = (coordinates: number[][]): void => {
      const id = `m-${String(ids.length)}`;
      ids.push(id);
      lines.addFeatures([lineOf(id, coordinates)]);
    };
    const readout = panel.readout();
    const between = (name: string, a: LonLat, b: LonLat): void => {
      const result = measureDistance(a, b);
      draw(greatCircle(a, b));
      readout([
        [name, formatLength(result.distanceMeters)],
        ['Bearing at the start', `${result.initialBearingDeg.toFixed(1)}°`],
        ['Bearing at the end', `${result.finalBearingDeg.toFixed(1)}°`],
      ]);
    };
    panel.buttons(
      ['Milan → Rome', () => between('Milan → Rome', MILAN, ROME)],
      ['Rome → New York', () => between('Rome → New York', ROME, NEW_YORK)],
    );
    panel.buttons(
      [
        'Milan · Rome · Venice',
        () => {
          const { areaSquareMeters, perimeterMeters } = measureArea([MILAN, ROME, VENICE]);
          draw([MILAN, ROME, VENICE, MILAN].map(pair));
          readout([
            ['Area', formatArea(areaSquareMeters)],
            ['Perimeter', formatLength(perimeterMeters)],
          ]);
        },
      ],
      ['Clear', () => (ids.splice(0).forEach((id) => lines.removeFeature(id)), readout([]))],
    );
    panel.note(
      'The ruler and pencil buttons at the top of the map measure and draw your own lines and areas, with editing.',
    );
    between('Rome → New York', ROME, NEW_YORK);
  },
};

/** The grid and the marker of the coordinates scene, redrawn for each position. */
function gridOf(context: SceneContext): (at: LonLat, spacingM: number) => void {
  const grid = context.add(
    new DataLayer('polyline', {
      id: 'coordinate-grid',
      style: { 'line-color': '#1a56db', 'line-width': 1, 'line-opacity': 0.55 },
    }),
  );
  const pin = context.add(
    new DataLayer('point', {
      id: 'coordinate-pin',
      style: {
        'circle-color': '#ff1744',
        'circle-radius': 6,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    }),
  );
  let count = 0;
  pin.addFeatures([
    { type: 'Feature', id: 'pin', properties: {}, geometry: { type: 'Point', coordinates: pair(MILAN) } },
  ]);
  return (at, spacingM) => {
    for (let i = 0; i < count; i++) grid.removeFeature(`g${String(i)}`);
    const segments = spacingM > 0 ? gridLines({ center: at, halfSizeM: spacingM * 10, spacingM }) : [];
    grid.addFeatures(segments.map(([a, b], i) => lineOf(`g${String(i)}`, [pair(a), pair(b)])));
    count = segments.length;
    pin.setFeaturePosition('pin', at.longitudeDeg, at.latitudeDeg);
  };
}

/** Typed coordinates read, written in every format and system, with a metric grid around them. */
export const coordinates: SceneModule = {
  code: `import { formatCoordinate, gridLines, parseCoordinate, transformCoordinates } from '@vibeglobe/gis';

const milan = parseCoordinate('32T 514853 5034537'); // also '45°27′51″N 9°11′24″E', '45.4642, 9.19'
formatCoordinate(milan, 'dms'); // '45°27′51.1″N 9°11′24.0″E'
transformCoordinates({ x: 9.19, y: 45.4642 }, 'EPSG:4326', 'EPSG:3857');
gridLines({ center: milan, halfSizeM: 5000, spacingM: 1000 }); // segments for a line layer`,
  start(context) {
    const { globe, panel, container } = context;
    context.go({ ...MILAN, zoom: 12.6, tiltDeg: 0, headingDeg: 0 });
    let at: LonLat = MILAN;
    let spacing = 1000;
    const draw = gridOf(context);
    const readout = panel.readout();
    const show = (): void => {
      const mercator = transformCoordinates({ x: at.longitudeDeg, y: at.latitudeDeg }, 'EPSG:4326', 'EPSG:3857');
      readout([
        ['Decimal', formatCoordinate(at, 'decimal') ?? ''],
        ['DMS', formatCoordinate(at, 'dms') ?? ''],
        ['UTM', formatCoordinate(at, 'utm') ?? 'outside UTM'],
        ['EPSG:3857', `${mercator.x.toFixed(1)}, ${mercator.y.toFixed(1)}`],
      ]);
      draw(at, spacing);
    };
    const input = panel.text('Coordinates', '32T 514853 5034537', (text) => {
      const result = parseCoordinateResult(text);
      if (!result.position) return readout([['Not read', result.error.message]]);
      at = result.position;
      show();
      void globe.flyTo({ ...at, zoom: Math.max(globe.camera.zoom, 11) });
    });
    input.placeholder = 'decimal, DMS or UTM';
    panel.select(
      'Grid',
      [
        ['0', 'None'],
        ['100', '100 m'],
        ['1000', '1 km'],
        ['10000', '10 km'],
      ],
      '1000',
      (value) => {
        spacing = Number(value);
        show();
      },
    );
    context.defer(
      watchClicks(container, globe, ({ position }) => {
        if (!position) return;
        at = position;
        input.value = formatCoordinate(position, 'dms') ?? '';
        show();
      }),
    );
    show();
    panel.note('Type a coordinate and press Enter, or click the map.');
  },
};

/** The view kept in the page's address, a link to it, and a picture of it with its credits. */
export const share: SceneModule = {
  code: `import { viewStateOf, viewStateToUrl } from '@vibeglobe/gis';
import { captureView } from '@vibeglobe/ui';

globe.on('moveend', () => {
  const view = viewStateOf(globe.camera);
  if (view) history.replaceState(null, '', viewStateToUrl(location.href, view)); // #view=…
});
const png = await captureView(globe, { widthPx: 1600, heightPx: 900 }); // with the credits`,
  start(context) {
    const { globe, panel } = context;
    context.go({ longitudeDeg: 11, latitudeDeg: 45.5, zoom: 4.8, tiltDeg: 0, headingDeg: 0 });
    const linkOf = (): string => {
      const view = viewStateOf(globe.camera);
      return view ? viewStateToUrl(location.href, view) : location.href;
    };
    let keep = true;
    context.on('moveend', () => keep && history.replaceState(null, '', linkOf()));
    panel.toggle('Keep the view in the address', true, (on) => (keep = on));
    const status = panel.readout();
    panel.buttons(
      [
        'Copy a link to this view',
        () => void navigator.clipboard?.writeText(linkOf()).then(() => status([['Link', 'copied']])),
      ],
      ['Take a picture', () => void picture(context, status)],
    );
    panel.note(
      'Bookmarks (the star at the top) keep views in this browser; the minimap at the bottom right shows where you are.',
    );
  },
};

/** Shows a picture of the view in the panel, with a link to save it. */
async function picture(
  context: SceneContext,
  status: (rows: readonly (readonly [string, string])[]) => void,
): Promise<void> {
  status([['Picture', 'waiting for the view to load…']]);
  const blob = await captureView(context.globe, { scale: 1 });
  const url = URL.createObjectURL(blob);
  context.defer(() => URL.revokeObjectURL(url));
  const image = element('img', 'tour-shot');
  image.src = url;
  image.alt = 'The view, with its credits';
  const link = element('a', 'tour-guide', 'Save the picture');
  link.href = url;
  link.download = 'vibeglobe-view.png';
  context.panel.element.querySelector('.tour-shot')?.remove();
  context.panel.element.append(image, link);
  status([['Picture', `${(blob.size / 1024).toFixed(0)} KB PNG`]]);
}
