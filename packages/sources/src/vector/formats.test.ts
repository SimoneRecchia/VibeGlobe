import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { failures, runParserConformance } from '../conformance/index.js';
import type { ParsedFeatures } from './features.js';
import { parseGeoJson } from './geojson.js';
import { parseGpx } from './gpx.js';
import { parseKml } from './kml.js';
import { VECTOR_TASKS } from './tasks.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../__fixtures__/vector/${name}`, import.meta.url), 'utf8');

const EVERY_TYPE = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'p',
      properties: { name: 'Rome', pop: 2.8e6 },
      geometry: { type: 'Point', coordinates: [12.5, 41.9, 21] },
    },
    {
      type: 'Feature',
      id: 2,
      properties: null,
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [2, 2],
            [3, 3],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
          [
            [2, 2],
            [4, 2],
            [4, 4],
            [2, 2],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [1, 2] },
          {
            type: 'GeometryCollection',
            geometries: [
              {
                type: 'LineString',
                coordinates: [
                  [0, 0],
                  [1, 0],
                ],
              },
            ],
          },
        ],
      },
    },
    // Crosses the antimeridian with longitudes beyond 180°, as some producers write it.
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [179, 10],
          [181, 11],
        ],
      },
    },
  ],
});

describe('parseGeoJson (F236)', () => {
  it('parses every geometry type, ids and properties as WGS84 longitude and latitude', () => {
    const { features, issues } = parseGeoJson(EVERY_TYPE);
    expect(issues).toEqual([]);
    expect(features.map((f) => f.geometry?.type)).toEqual([
      'Point',
      'MultiPoint',
      'LineString',
      'MultiLineString',
      'Polygon',
      'MultiPolygon',
      'GeometryCollection',
      'LineString',
    ]);
    expect(features[0]).toEqual({
      id: 'p',
      properties: { name: 'Rome', pop: 2.8e6 },
      geometry: { type: 'Point', coordinates: [12.5, 41.9, 21] },
    });
    expect(features[1]?.id).toBe(2);
    expect(features[4]?.geometry).toMatchObject({
      coordinates: [
        expect.any(Array),
        [
          [2, 2],
          [4, 2],
          [4, 4],
          [2, 2],
        ],
      ],
    });
    expect(features[7]?.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [179, 10],
        [181, 11],
      ],
    });
    expect(parseGeoJson('{"type":"Point","coordinates":[1,2]}').features[0]?.geometry).toEqual({
      type: 'Point',
      coordinates: [1, 2],
    });
  });

  it('reports invalid features by index and keeps the valid ones', () => {
    const document = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } },
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: ['NaN', 2] } },
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
            ],
          },
        },
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [0, 0] } },
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 95] } },
        { type: 'Feature', properties: {}, geometry: null },
      ],
    });
    const { features, issues } = parseGeoJson(document);
    expect(features).toHaveLength(2);
    expect(issues.map((i) => i.index)).toEqual([1, 2, 3, 4]);
    expect(issues[1]?.message).toMatch(/not closed/);
    expect(parseGeoJson('{"type":').issues[0]?.index).toBe(-1);
  });

  it('parses a 100 MB document', () => {
    const one = JSON.stringify({
      type: 'Feature',
      properties: { name: 'segment', lanes: 2 },
      geometry: {
        type: 'LineString',
        coordinates: [
          [12.4921, 41.8902],
          [12.4964, 41.9028],
          [12.5113, 41.8986],
        ],
      },
    });
    const count = Math.ceil((100 * 1024 * 1024) / (one.length + 1));
    const text = `{"type":"FeatureCollection","features":[${`${one},`.repeat(count - 1)}${one}]}`;
    expect(text.length).toBeGreaterThanOrEqual(100 * 1024 * 1024);
    const parsed = parseGeoJson(text);
    expect([parsed.features.length, parsed.issues.length]).toEqual([count, 0]);
  });
});

describe('parseKml (F237)', () => {
  it('maps folders, StyleMaps, inline styles, ExtendedData, altitude modes and every geometry', () => {
    const kml = parseKml(fixture('synthetic.kml'));
    expect(kml.features.map((f) => [f.name, f.geometry?.type, f.folders, f.altitudeMode])).toEqual([
      ['Summit & view', 'Point', ['Trip', 'Day 1', 'Morning'], 'absolute'],
      ['Path', 'LineString', ['Trip', 'Day 1'], 'relativeToSeaFloor'],
      ['Lake', 'Polygon', ['Trip'], 'clampToGround'],
      ['Both', 'GeometryCollection', ['Trip'], 'clampToGround'],
    ]);
    const [summit, path, lake, both] = kml.features;
    expect(summit).toMatchObject({
      id: 'p1',
      description: '<b>Top</b> of the hill',
      geometry: { coordinates: [6.8652, 45.8326, 4808] },
      properties: { name: 'Summit & view', elevation: '4808', rating: '5' },
      style: { iconHref: 'files/pin.png', iconScale: 1.2, lineColor: '#ff0000ff', lineWidthPx: 3 },
      highlightStyle: { iconScale: 2 },
    });
    expect(path?.style).toMatchObject({ lineColor: '#ff0000ff', lineWidthPx: 5 });
    expect(lake?.style).toEqual({ polygonColor: '#00ff007f', fill: true, outline: false });
    expect(lake?.geometry).toMatchObject({
      coordinates: [
        expect.any(Array),
        [
          [6.4, 45.4],
          [6.6, 45.4],
          [6.6, 45.6],
          [6.4, 45.6],
          [6.4, 45.4],
        ],
      ],
    });
    expect(both?.geometry).toMatchObject({ geometries: [{ type: 'Point' }, { type: 'LineString' }] });
    expect(kml.groundOverlays).toEqual([
      {
        name: 'Scan',
        href: 'files/overlay.png',
        north: 46,
        south: 45,
        east: 7,
        west: 6,
        rotationDeg: 12.5,
        folders: ['Trip'],
      },
    ]);
    expect(kml.issues).toEqual([{ index: 4, message: "invalid coordinates 'abc,def'" }]);
  });

  it('extracts the icons and the overlay image of a KMZ archive', () => {
    const pin = new Uint8Array([137, 80, 78, 71, 1]);
    const overlay = new Uint8Array([137, 80, 78, 71, 2]);
    const kmz = zipSync({
      'doc.kml': strToU8(fixture('synthetic.kml')),
      files: { 'pin.png': pin, 'overlay.png': overlay },
    });
    const kml = parseKml(kmz);
    expect(kml.features).toHaveLength(4);
    expect(kml.features[0]?.style?.iconHref).toBe('files/pin.png');
    expect(kml.resources).toEqual({ 'files/pin.png': pin, 'files/overlay.png': overlay });
    expect(kml.groundOverlays[0]?.href).toBe('files/overlay.png');
  });

  it('passes the KML conformance suite on documents exported from common tools', async () => {
    const counts = {
      'point.kml': 1,
      'linestring.kml': 2,
      'polygon.kml': 1,
      'multigeometry.kml': 1,
      'style.kml': 3,
      // An empty <coordinates /> is reported as an issue of that placemark, not a crash.
      'selfclosing.kml': 0,
      'simpledata.kml': 2,
    };
    const results = await runParserConformance({
      name: 'kml',
      parse: (input: string) => parseKml(input),
      fixtures: Object.entries(counts).map(([name, count]) => ({
        name,
        input: fixture(name),
        expect: (kml: ReturnType<typeof parseKml>) =>
          kml.features.length === count && kml.issues.length === (name === 'selfclosing.kml' ? 1 : 0)
            ? undefined
            : `${kml.features.length} features, ${JSON.stringify(kml.issues)}`,
      })),
    });
    expect(failures(results)).toEqual([]);
  });
});

describe('parseGpx (F238)', () => {
  it('maps waypoints, routes and tracks with segments, elevation and time (GPX 1.0)', () => {
    const gpx = parseGpx(fixture('gpx10.gpx'));
    expect(gpx.version).toBe('1.0');
    expect(gpx.features.map((f) => [f.kind, f.geometry?.type])).toEqual([
      ['waypoint', 'Point'],
      ['route', 'LineString'],
      ['track', 'MultiLineString'],
    ]);
    const [waypoint, route, track] = gpx.features;
    expect(waypoint).toMatchObject({
      geometry: { coordinates: [6.8652, 45.8326, 4808] },
      properties: { name: 'Mont Blanc', sym: 'Summit', links: ['https://summit.test/'] },
      times: [Date.parse('2024-07-01T06:00:00Z')],
    });
    expect(route?.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [6.8, 45.9],
        [6.85, 45.85, 3800],
      ],
    });
    expect(track?.geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [
        [
          [7, 45, 100],
          [7.1, 45.1, 110.5],
        ],
        [
          [7.3, 45.3],
          [7.4, 45.4],
        ],
      ],
    });
    expect(track?.times).toEqual([
      [Date.parse('2024-07-01T07:00:00Z'), Date.parse('2024-07-01T07:10:00Z')],
      [NaN, NaN],
    ]);
    expect(gpx.issues).toEqual([{ index: 3, message: 'invalid point lat="91" lon="0"' }]);
  });

  it('passes the GPX conformance suite on files from GPS devices and apps (GPX 1.0 and 1.1)', async () => {
    const results = await runParserConformance({
      name: 'gpx',
      parse: (input: string) => parseGpx(input),
      fixtures: [
        ['run.gpx', '1.1', 206],
        ['garmin_extensions.gpx', '1.1', 4],
        ['osm.gpx', '1.0', 420],
      ].map(([name, version, points]) => ({
        name: String(name),
        input: fixture(String(name)),
        expect: (gpx: ReturnType<typeof parseGpx>) => {
          const tracks = gpx.features.filter((f) => f.kind === 'track');
          const total = tracks.reduce((n, t) => n + (t.times as number[][]).flat().length, 0);
          const timed =
            name !== 'run.gpx' || tracks.every((t) => (t.times as number[][]).flat().every(Number.isFinite));
          return gpx.version === version && total === points && timed && gpx.issues.length === 0
            ? undefined
            : `${gpx.version}, ${total} points`;
        },
      })),
    });
    expect(failures(results)).toEqual([]);
  });
});

describe('vector worker tasks', () => {
  it('run every parser from transferable bytes and never throw on garbage', async () => {
    const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;
    const context = { isCancelled: () => false };
    const run = async (task: string, input: unknown) => (await VECTOR_TASKS[task]?.(input, context))?.output;
    expect(((await run('parse-geojson', { bytes: bytes(EVERY_TYPE) })) as ParsedFeatures).features).toHaveLength(8);
    expect(((await run('parse-kml', { text: fixture('point.kml') })) as ParsedFeatures).features).toHaveLength(1);
    expect(((await run('parse-gpx', { bytes: bytes(fixture('gpx10.gpx')) })) as ParsedFeatures).features).toHaveLength(
      3,
    );
    expect(await run('decode-mvt', { bytes: bytes('not a tile') })).toBeUndefined();
    await expect(Promise.resolve().then(() => run('parse-gpx', {}))).rejects.toMatchObject({ code: 'invalid-input' });
  });
});

describe('vector fuzzing (F236, F237)', () => {
  it('no mutated GeoJSON document or KMZ archive makes a parser throw', async () => {
    const kmz = zipSync({ 'doc.kml': strToU8(fixture('synthetic.kml')), 'files/pin.png': new Uint8Array([1, 2, 3]) });
    const geojson = await runParserConformance({
      name: 'geojson',
      parse: (input: string) => parseGeoJson(input),
      fixtures: [{ name: 'every type', input: EVERY_TYPE, expect: () => undefined }],
      fuzzRuns: 500,
    });
    const archives = await runParserConformance({
      name: 'kmz',
      parse: (input: Uint8Array) => parseKml(input),
      fixtures: [
        {
          name: 'synthetic.kmz',
          input: kmz,
          expect: (kml: ReturnType<typeof parseKml>) => (kml.features.length === 4 ? undefined : 'features'),
        },
      ],
      fuzzRuns: 300,
    });
    expect(failures([...geojson, ...archives])).toEqual([]);
  });
});
