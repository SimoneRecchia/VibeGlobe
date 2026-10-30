// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { xyzImagery } from '@vibeglobe/sources';
import { describe, expect, it } from 'vitest';
import { europeOpen } from './europe.js';
import type { PresetSourceRecord } from './sources.js';
import type { StyleJson, StyleLayerJson } from './styles.js';

const STYLE: StyleJson = {
  version: 8,
  glyphs: 'https://fonts.test/{fontstack}/{range}.pbf',
  sources: { openmaptiles: { type: 'vector', url: 'https://tiles.test/planet' } },
  layers: [
    { id: 'road', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' },
    {
      id: 'city',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      layout: { 'text-font': ['Noto Sans Regular'] },
    },
  ],
};
const RECORD: PresetSourceRecord = {
  id: 'app-land-cover',
  name: 'Land cover',
  kind: 'base-image',
  tiers: 'network',
  license: 'Public domain',
  termsUrl: 'https://terms.test',
  termsReadDate: '2026-10-30',
  attribution: [{ text: 'Land cover' }],
  minLevel: 0,
  maxLevel: 5,
  coverage: 'world',
};
const COVER = xyzImagery({ id: 'app-land-cover', url: 'https://app.test/{z}/{x}/{y}.webp', maxLevel: 5 });

const byId = (layers: readonly StyleLayerJson[] | undefined, id: string) => layers?.find((l) => l.id === id);

describe('the Landscape map (F644)', () => {
  it("draws land by its cover, a light hillshade and light blue water, over the app's land cover far away", () => {
    const plain = europeOpen().styleFor(STYLE, 'landscape', []);
    expect(plain?.layers.map((l) => l.id)).toEqual([
      'landscape-land',
      'landscape-wood',
      'landscape-grass',
      'landscape-wetland',
      'landscape-farmland',
      'landscape-rock',
      'landscape-sand',
      'landscape-ice',
      'landscape-urban',
      'landscape-hillshade',
      'landscape-water',
      'landscape-rivers',
    ]);
    // No land cover image: the land is opaque at every level, and the tiles' cover from level 7 (ice from 0).
    expect(byId(plain?.layers, 'landscape-land')?.['paint']).toMatchObject({ 'background-opacity': 1 });
    expect(byId(plain?.layers, 'landscape-wood')?.['minzoom']).toBe(7);
    expect(byId(plain?.layers, 'landscape-ice')?.['minzoom']).toBe(0);
    const preset = europeOpen({ landCover: { source: COVER, record: RECORD } });
    const landscape = preset.baseMaps.find((b) => b.id === 'landscape');
    expect(landscape?.imagery.map((l) => l.sources[0]?.id)).toEqual(['app-land-cover']);
    expect(preset.sources.some((s) => s.id === 'app-land-cover')).toBe(true);
    expect(landscape?.polarCapColors).toEqual({ north: '#8ad3e9', south: '#fcfdfd' });
    // With it, the land color covers the image from level 7 to 8.
    const over = preset.styleFor(STYLE, 'landscape', []);
    const fade = ['interpolate', ['linear'], ['zoom'], 7, 0, 8, 1];
    expect(byId(over?.layers, 'landscape-land')?.['paint']).toMatchObject({ 'background-opacity': fade });
    expect(byId(over?.layers, 'landscape-wood')?.['paint']).toMatchObject({ 'fill-opacity': fade });
  });
});

describe('borders, country and sea names overlays (F645)', () => {
  it('draw country borders, region borders from level 5, country names to 8 and sea names, light on imagery, dark on the Landscape', () => {
    const preset = europeOpen();
    const all = ['borders', 'countries', 'seas'] as const;
    const satellite = preset.styleFor(STYLE, 'satellite', [...all])?.layers;
    expect(satellite?.map((l) => l.id)).toEqual([
      'overlay-region-borders',
      'overlay-country-borders',
      'overlay-sea-names',
      'overlay-country-names',
    ]);
    const regions = byId(satellite, 'overlay-region-borders');
    expect(regions?.['minzoom']).toBe(5);
    expect(regions?.['filter']).toEqual(['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]]);
    expect(byId(satellite, 'overlay-country-names')?.['maxzoom']).toBe(8);
    expect(byId(satellite, 'overlay-country-names')?.['paint']).toMatchObject({ 'text-color': '#ffffff' });
    // Each overlay alone; on the Landscape between its water and the names, with the roads below the borders.
    expect(preset.styleFor(STYLE, 'satellite', ['countries'])?.layers.map((l) => l.id)).toEqual([
      'overlay-country-names',
    ]);
    const landscape = preset.styleFor(STYLE, 'landscape', ['roads', ...all])?.layers.map((l) => l.id);
    expect(landscape?.slice(-6)).toEqual([
      'landscape-rivers',
      'road',
      'overlay-region-borders',
      'overlay-country-borders',
      'overlay-sea-names',
      'overlay-country-names',
    ]);
    const names = byId(preset.styleFor(STYLE, 'landscape', ['countries'])?.layers, 'overlay-country-names');
    expect(names?.['paint']).toMatchObject({ 'text-color': '#2f2c33', 'text-halo-color': '#ffffff' });
    // Names in the app's language where the tiles have it, else Latin or local.
    const italian = byId(preset.styleFor(STYLE, 'satellite', ['countries'], 'it')?.layers, 'overlay-country-names');
    expect(italian?.['layout']).toMatchObject({
      'text-field': ['coalesce', ['get', 'name:it'], ['get', 'name:latin'], ['get', 'name']],
    });
  });
});
