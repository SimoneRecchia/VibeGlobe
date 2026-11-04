// F697: ready implementations of the services for MapTiler, Esri, OpenFreeMap and Photon.
import type { ImagerySource, TileCoord, TileService } from '@vibeglobe/core';
import type { DescribedImagerySource } from '@vibeglobe/sources';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EsriTiles, MapTilerTerrain, MapTilerTiles, OpenFreeMapTiles, PhotonGeocoder } from './index.js';

const coord: TileCoord = { root: 0, level: 5, x: 17, y: 11 };
const only = (tiles: TileService): DescribedImagerySource => {
  const [source] = tiles.imagery();
  expect(tiles.imagery()).toHaveLength(1);
  return source as DescribedImagerySource;
};
const urlOf = (source: ImagerySource | { request: ImagerySource['request'] }): string => {
  const request = source.request(coord, { url: '', hostIndex: 0 });
  return typeof request === 'string' ? request : request.url;
};

it('keeps every provider out of the engine packages', async () => {
  const engine = [await import('@vibeglobe/core'), await import('@vibeglobe/sources')];
  const names = engine.flatMap((module) => Object.keys(module));
  expect(names.filter((name) => /maptiler|esri|openfreemap|photon|openstreetmap|osm_|google/i.test(name))).toEqual([]);
});

describe('MapTiler', () => {
  it('serves the satellite imagery with the key and its required credit, or a map from its vector style', () => {
    const satellite = only(new MapTilerTiles({ key: 'k y' }));
    expect(urlOf(satellite)).toBe('https://api.maptiler.com/tiles/satellite-v2/5/17/11.jpg?key=k%20y');
    expect(satellite).toMatchObject({ tileSizePx: 512, maxLevel: 20 });
    expect(satellite.attribution[0]?.text).toBe('© MapTiler © OpenStreetMap contributors');
    expect(satellite.profile.forbids.has('offlinePackaging')).toBe(true);
    expect(new MapTilerTiles({ key: 'k' }).style()).toBeUndefined();
    const streets = new MapTilerTiles({ key: 'k', map: 'streets-v2' });
    expect(streets.imagery()).toEqual([]);
    expect(streets.style()).toBe('https://api.maptiler.com/maps/streets-v2/style.json?key=k');
  });

  it('serves Terrain-RGB heights for the 3D view, and refuses a missing key', () => {
    const terrain = new MapTilerTerrain({ key: 'k' }).terrain();
    expect(terrain.decoder).toEqual({ kind: 'terrain-rgb' });
    expect(terrain.maxLevel).toBe(14);
    expect(urlOf(terrain)).toBe('https://api.maptiler.com/tiles/terrain-rgb-v2/5/17/11.webp?key=k');
    expect(() => new MapTilerTiles({ key: '' })).toThrow(/API key/);
    expect(() => new MapTilerTerrain({ key: ' ' })).toThrow(/API key/);
  });
});

describe('Esri', () => {
  it('requests row before column, with the token, "Powered by Esri" and the data credit', () => {
    const imagery = only(new EsriTiles());
    expect(urlOf(imagery)).toBe(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/5/11/17',
    );
    expect(imagery.attribution.map((credit) => credit.text)).toEqual([
      'Powered by Esri',
      'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    ]);
    // The grey "Map data not yet available" filler counts as no data (F691).
    expect(imagery.blankTile).toEqual({ rgb: [204, 204, 204], share: 0.9 });
    const streets = only(new EsriTiles({ map: 'streets', token: 't&1' }));
    expect(urlOf(streets)).toBe(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/5/11/17?token=t%261',
    );
  });
});

describe('OpenFreeMap', () => {
  it('draws its vector style, Liberty by default, without imagery or key', () => {
    expect(new OpenFreeMapTiles().imagery()).toEqual([]);
    expect(new OpenFreeMapTiles().style()).toBe('https://tiles.openfreemap.org/styles/liberty');
    expect(new OpenFreeMapTiles({ style: 'positron' }).style()).toBe('https://tiles.openfreemap.org/styles/positron');
  });
});

describe('Photon', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (body: unknown, status = 200) => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };
  const signal = new AbortController().signal;

  it('asks for the query in the language when the instance has it, and reads places and their extent', async () => {
    const fetch = answer({
      features: [
        {
          geometry: { coordinates: [13.24, 52.51] },
          properties: {
            name: 'Olympiastadion',
            city: 'Berlin',
            state: 'Berlin',
            country: 'Germany',
            extent: [13.23, 52.52, 13.25, 52.51],
          },
        },
        {
          geometry: { coordinates: [12.5, 41.9] },
          properties: { street: 'Via del Corso', housenumber: '1', city: 'Roma' },
        },
        { geometry: {}, properties: { name: 'nowhere' } },
      ],
    });
    const results = await new PhotonGeocoder().search('stadion & co', { signal, language: 'de' });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://photon.komoot.io/api/?q=stadion%20%26%20co&limit=5&lang=de');
    expect(results).toEqual([
      {
        label: 'Olympiastadion, Berlin, Germany',
        longitudeDeg: 13.24,
        latitudeDeg: 52.51,
        bounds: { westDeg: 13.23, southDeg: 52.51, eastDeg: 13.25, northDeg: 52.52 },
      },
      { label: 'Via del Corso 1, Roma', longitudeDeg: 12.5, latitudeDeg: 41.9 },
    ]);
  });

  it('leaves other languages to the local names, takes its own instance, and fails on an HTTP error', async () => {
    const fetch = answer({ features: [] });
    await expect(
      new PhotonGeocoder({ url: 'https://geo.test/' }).search('roma', { signal, language: 'it' }),
    ).resolves.toEqual([]);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://geo.test/api/?q=roma&limit=5');
    answer({}, 500);
    await expect(new PhotonGeocoder().search('roma', { signal, language: 'en' })).rejects.toThrow(/HTTP 500/);
  });
});
