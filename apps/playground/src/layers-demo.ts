import type { Globe } from '@vibeglobe/core';
import { allAltitudeLayers, altitudeModels } from './layers-altitudes.js';
import { fitLayers } from './layers-fit.js';
import { manyPointsLayer, pickLayers } from './layers-many.js';
import { selectLayers, selectModels } from './layers-select.js';
import type { ModelLayer } from '@vibeglobe/layers/models';
import { styledLayers } from './layers-styled.js';
import { markerImages } from './marker-images.js';
import {
  createGlobeLayers,
  DataLayer,
  type InteractionController,
  type Feature,
  type Geometry,
  type LayerStack,
} from '@vibeglobe/layers';

declare global {
  interface Window {
    /** The `?layers=demo` stack and its layers, for the end-to-end tests of M10. */
    vibeglobeLayers?: {
      stack: LayerStack;
      layers: Record<string, DataLayer>;
      interaction?: InteractionController;
      /** The glTF models of `?scenario=data-select` (F381). */
      models?: ModelLayer;
    };
  }
}

/** A closed ring of a rectangle in degrees, counterclockwise. */
function rectangle(west: number, south: number, east: number, north: number): number[][] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/**
 * `?layers=demo` (M10, ADR 0037): points, a line, a polygon with a hole and an extruded polygon around Rome, drawn by
 * the renderer through the layers package's public API.
 */
export function showLayersDemo(globe: Globe): void {
  const { stack } = createGlobeLayers(globe);
  const points = stack.add(
    new DataLayer('point', {
      id: 'points',
      data: [
        { type: 'Feature', id: 'a', properties: {}, geometry: { type: 'Point', coordinates: [12.45, 41.9] } },
        { type: 'Feature', id: 'b', properties: {}, geometry: { type: 'Point', coordinates: [12.55, 41.9] } },
      ],
      style: { 'circle-color': '#ff2020', 'circle-radius': 10 },
    }),
  );
  const line = stack.add(
    new DataLayer('polyline', {
      id: 'line',
      data: [
        {
          type: 'Feature',
          id: 'l',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [12.4, 41.85],
              [12.6, 41.95],
            ],
          },
        },
      ],
      style: { 'line-color': '#2050ff', 'line-width': 6 },
    }),
  );
  const polygon = stack.add(
    new DataLayer('polygon', {
      id: 'polygon',
      data: [
        {
          type: 'Feature',
          id: 'p',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [rectangle(12.4, 41.8, 12.6, 41.85), rectangle(12.48, 41.81, 12.52, 41.84)],
          },
        },
      ],
      style: { 'fill-color': '#20c040', 'fill-opacity': 0.8 },
    }),
  );
  window.vibeglobeLayers = { stack, layers: { points, line, polygon } };
}

function feature(id: string, geometry: Geometry, properties: Record<string, unknown> = {}): Feature {
  return { type: 'Feature', id, properties, geometry };
}

/** 1,000 points on a golden-angle spiral over the whole globe, deterministic, and a grid around Rome (F351). */
function worldPoints(): Feature[] {
  const points: Feature[] = [];
  for (let i = 0; i < 1000; i++) {
    const lat = (Math.asin(-1 + (2 * (i + 0.5)) / 1000) * 180) / Math.PI;
    const lon = ((((i * 137.50776405) % 360) + 540) % 360) - 180;
    points.push(feature(`p${String(i)}`, { type: 'Point', coordinates: [lon, lat] }, { r: 3 + (i % 3) }));
  }
  // And a 10 × 10 grid around Rome, 0.6° apart, for the flat and tilted views at city to region scale.
  for (let i = 0; i < 100; i++)
    points.push(
      feature(
        `g${String(i)}`,
        { type: 'Point', coordinates: [9.8 + (i % 10) * 0.6, 39.2 + Math.floor(i / 10) * 0.6] },
        { r: 4 },
      ),
    );
  return points;
}

/** The data layers' test scenes (F351, F353, F354), by scenario name. */
const DATA_SCENES: Record<string, () => DataLayer> = {
  'data-points': () =>
    new DataLayer('point', {
      id: 'points',
      data: worldPoints(),
      style: { 'circle-color': '#ff2020', 'circle-radius': ['get', 'r'] },
    }),
  'data-lines': () =>
    new DataLayer('polyline', {
      id: 'lines',
      data: [
        // Short, intercontinental (Rome to New York) and across the antimeridian, at widths 2, 4 and 8.
        feature(
          'short',
          {
            type: 'LineString',
            coordinates: [
              [12.4, 41.8],
              [12.6, 42.0],
            ],
          },
          { w: 2 },
        ),
        feature(
          'atlantic',
          {
            type: 'LineString',
            coordinates: [
              [12.5, 41.9],
              [-74, 40.7],
            ],
          },
          { w: 4 },
        ),
        feature(
          'pacific',
          {
            type: 'LineString',
            coordinates: [
              [170, -10],
              [-170, 10],
            ],
          },
          { w: 8 },
        ),
      ],
      style: { 'line-color': '#2050ff', 'line-width': ['get', 'w'] },
    }),
  'data-polygons': () =>
    new DataLayer('polygon', {
      id: 'polygons',
      data: [
        feature('small', { type: 'Polygon', coordinates: [rectangle(12.4, 41.8, 12.6, 42.0)] }),
        feature('holed', { type: 'Polygon', coordinates: [rectangle(0, 40, 10, 50), rectangle(3, 43, 7, 47)] }),
        // About the size of Australia.
        feature('continent', { type: 'Polygon', coordinates: [rectangle(113, -39, 154, -11)] }),
      ],
      style: { 'fill-color': '#20c040', 'fill-opacity': 0.9 },
    }),
  // Latin with accents, Greek, Cyrillic and CJK, at several sizes, colors and anchors (F357).
  'data-labels': () =>
    new DataLayer('label', {
      id: 'labels',
      data: [
        feature(
          'roma',
          { type: 'Point', coordinates: [12.5, 41.9] },
          { t: 'Roma – Città', s: 20, c: '#ffd000', a: 'center' },
        ),
        feature('athens', { type: 'Point', coordinates: [23.7, 38.0] }, { t: 'Αθήνα', s: 16, c: '#40e0ff', a: 'left' }),
        feature(
          'moscow',
          { type: 'Point', coordinates: [37.6, 55.75] },
          { t: 'Москва', s: 24, c: '#ff60ff', a: 'bottom' },
        ),
        feature('tokyo', { type: 'Point', coordinates: [139.7, 35.7] }, { t: '東京', s: 18, c: '#ffffff', a: 'top' }),
      ],
      style: {
        'text-field': ['get', 't'],
        'text-size': ['get', 's'],
        'text-color': ['get', 'c'],
        'text-anchor': ['get', 'a'],
      },
    }),
  // Circles and an ellipse at the equator, at 60° and near a pole, radii in meters (F356).
  'data-circles': () =>
    new DataLayer('circle', {
      id: 'circles',
      data: [
        feature('equator', { type: 'Point', coordinates: [10, 0] }, { radiusMeters: 500_000 }),
        feature('sixty', { type: 'Point', coordinates: [10, 60] }, { radiusMeters: 500_000 }),
        feature('pole', { type: 'Point', coordinates: [0, 87] }, { radiusMeters: 300_000 }),
        feature(
          'ellipse',
          { type: 'Point', coordinates: [40, 30] },
          { radiusMeters: 600_000, minorRadiusMeters: 200_000, rotationDeg: 45 },
        ),
      ],
      style: { 'fill-color': '#ff8000', 'fill-opacity': 0.9 },
    }),
  // Adjacent extruded blocks of different heights and bases (F355).
  'data-extrusions': () =>
    new DataLayer('polygon', {
      id: 'extrusions',
      data: [
        feature('low', { type: 'Polygon', coordinates: [rectangle(12.49, 41.89, 12.495, 41.895)] }, { h: 100, b: 0 }),
        feature('high', { type: 'Polygon', coordinates: [rectangle(12.495, 41.89, 12.5, 41.895)] }, { h: 300, b: 0 }),
        feature(
          'floating',
          { type: 'Polygon', coordinates: [rectangle(12.5, 41.89, 12.505, 41.895)] },
          { h: 400, b: 200 },
        ),
      ],
      style: {
        'fill-color': '#c0a080',
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-base': ['get', 'b'],
      },
    }),
  // Points on the ground across the fixture's 4,000 m peak at (6.86°, 45.83°), with `&terrain=terrarium` (F363).
  'data-clamped': () =>
    new DataLayer('point', {
      id: 'clamped',
      data: Array.from({ length: 100 }, (_, i) =>
        feature(`c${String(i)}`, {
          type: 'Point',
          coordinates: [6.61 + (i % 10) * 0.05, 45.6 + Math.floor(i / 10) * 0.05],
        }),
      ),
      style: { 'circle-color': '#ff2020', 'circle-radius': 4 },
    }),
  // A line and a polygon draped over the fixture's peak, with `&terrain=terrarium` (F364, F365).
  'draped-lines': () =>
    new DataLayer('polyline', {
      id: 'draped-line',
      data: [
        feature('ridge', {
          type: 'LineString',
          coordinates: [
            [6.5, 45.83],
            [7.2, 45.83],
          ],
        }),
      ],
      style: { 'line-color': '#2050ff', 'line-width': 5 },
    }),
  'draped-polygons': () =>
    new DataLayer('polygon', {
      id: 'draped-polygon',
      data: [feature('summit', { type: 'Polygon', coordinates: [rectangle(6.7, 45.72, 7.0, 45.95)] })],
      style: { 'fill-color': '#20c040', 'fill-opacity': 0.9 },
    }),
  // Images with several anchors, sizes and rotations (F352).
  'data-markers': () =>
    new DataLayer('marker', {
      id: 'markers',
      data: [
        feature('m1', { type: 'Point', coordinates: [12.5, 41.9] }, { i: 'pin', a: 'bottom', r: 0 }),
        feature('m2', { type: 'Point', coordinates: [14.25, 40.85] }, { i: 'square', a: 'center', r: 45 }),
      ],
      style: { 'icon-image': ['get', 'i'], 'icon-anchor': ['get', 'a'], 'icon-rotate': ['get', 'r'], 'icon-size': 32 },
    }),
};

/**
 * `?scenario=data-points`, `data-lines` and `data-polygons` (F351, F353, F354): the data layers' test scenes, drawn
 * through the layers package's public API.
 */
/** Points at 0, 1,000 and 10,000 m above the ellipsoid, one layer each (F362). */
function altitudeLayers(): DataLayer[] {
  return [0, 1000, 10_000].map(
    (altitude, i) =>
      new DataLayer('point', {
        id: `altitude-${String(altitude)}`,
        data: [feature(`a${String(i)}`, { type: 'Point', coordinates: [12.5 + i * 0.05, 41.9] })],
        placement: { absoluteAltitudeMeters: altitude },
        style: { 'circle-color': '#ff2020', 'circle-radius': 5 },
      }),
  );
}

/** `?scenario=data-models`: the fixture pyramid, 1 km across, at two coordinates and headings (F361). */
async function showModels(globe: Globe): Promise<void> {
  const url = `${import.meta.env.BASE_URL}models/pyramid.gltf`;
  await globe.addModel({ url, position: { longitudeDeg: 12.45, latitudeDeg: 41.9, heightMeters: 0 }, scale: 500 });
  await globe.addModel({
    url,
    position: { longitudeDeg: 12.55, latitudeDeg: 41.9, heightMeters: 0 },
    headingDeg: 90,
    scale: 500,
  });
}

/** `?scenario=data-sync`: one of each primitive over Rome, for the zoom from the globe to the street (F366). */
function syncLayers(): DataLayer[] {
  return [
    new DataLayer('polygon', {
      id: 'sync-polygon',
      data: [feature('p', { type: 'Polygon', coordinates: [rectangle(12.49, 41.885, 12.5, 41.895)] })],
      style: { 'fill-color': '#20c040', 'fill-opacity': 1 },
    }),
    new DataLayer('polyline', {
      id: 'sync-line',
      data: [
        feature('l', {
          type: 'LineString',
          coordinates: [
            [12.505, 41.885],
            [12.505, 41.895],
          ],
        }),
      ],
      style: { 'line-color': '#2050ff', 'line-width': 6 },
    }),
    new DataLayer('point', {
      id: 'sync-point',
      data: [feature('pt', { type: 'Point', coordinates: [12.51, 41.89] })],
      style: { 'circle-color': '#ff2020', 'circle-radius': 6 },
    }),
    new DataLayer('label', {
      id: 'sync-label',
      data: [feature('lb', { type: 'Point', coordinates: [12.495, 41.9] }, { t: 'Roma' })],
      style: { 'text-field': ['get', 't'], 'text-size': 16, 'text-color': '#ffd000' },
    }),
  ];
}

export function showDataScenario(globe: Globe, name: string): void {
  const element = document.querySelector<HTMLElement>('#globe') ?? undefined;
  const { stack, interaction } = createGlobeLayers(globe, element ? { element } : {});
  if (['data-markers', 'data-styled', 'data-select', 'data-altitudes-all'].includes(name))
    for (const [image, source] of Object.entries(markerImages())) globe.layerTarget()?.addImage?.(image, source);
  const scene = name === 'data-points-100k' ? manyPointsLayer : DATA_SCENES[name];
  const added = scene
    ? [scene()]
    : name === 'data-altitudes'
      ? altitudeLayers()
      : name === 'data-altitudes-all'
        ? allAltitudeLayers()
        : name === 'data-sync'
          ? syncLayers()
          : name === 'data-styled'
            ? styledLayers()
            : name === 'data-select'
              ? selectLayers()
              : name === 'data-pick'
                ? pickLayers()
                : name === 'data-fit'
                  ? fitLayers(globe)
                  : [];
  const layers = Object.fromEntries(added.map((layer) => [layer.id, stack.add(layer)]));
  if (name === 'data-models' || name === 'data-sync') {
    const models =
      name === 'data-models'
        ? showModels(globe)
        : globe.addModel({
            url: `${import.meta.env.BASE_URL}models/pyramid.gltf`,
            position: { longitudeDeg: 12.515, latitudeDeg: 41.89, heightMeters: 0 },
            scale: 60,
          });
    void models.then(() => (window.vibeglobeLayers = { stack, layers, interaction }));
    return;
  }
  if (name === 'data-select' || name === 'data-altitudes-all') {
    const models = stack.add(name === 'data-select' ? selectModels(import.meta.env.BASE_URL) : altitudeModels());
    void models.ready.then(() => (window.vibeglobeLayers = { stack, layers, interaction, models }));
    return;
  }
  window.vibeglobeLayers = { stack, layers, interaction };
}
