import { describe, expect, it } from 'vitest';
import type { SourceConfig } from '../config/schema.js';
import { checkSource } from './gate.js';
import { PROVIDER_PROFILES } from './profiles.js';

const xyz = (url: string): SourceConfig => ({ type: 'xyz', url });

describe('license gate', () => {
  it.each(PROVIDER_PROFILES.map((p) => [p.id, p.offlinePackaging && p.redistribution] as const))(
    'profile %s is allowed: %s',
    (id, allowed) => {
      const violation = checkSource('d', id, xyz('https://tiles.example.test/{z}/{x}/{y}.png'));
      expect(violation === undefined).toBe(allowed);
      if (!allowed) expect(violation?.term).toMatch(/forbid|non-commercial/);
    },
  );

  it('refuses forbidden hosts and editions whatever profile the configuration names', () => {
    expect(checkSource('d', 'fixture', xyz('https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'))?.profile).toBe(
      'openstreetmap-tile-servers',
    );
    // The tile servers' short alias (DP-005).
    expect(checkSource('d', 'fixture', xyz('https://tile.osm.org/{z}/{x}/{y}.png'))?.profile).toBe(
      'openstreetmap-tile-servers',
    );
    expect(checkSource('d', 'fixture', xyz('https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}'))?.profile).toBe(
      'google-maps-platform',
    );
    expect(
      checkSource('d', 'openstreetmap-extract', {
        type: 'osm-extract',
        url: 'https://download.geofabrik.de/europe/italy-latest.osm.pbf',
      }),
    ).toBeUndefined();
  });
});

describe('license gate and EOX layer URLs', () => {
  it('refuses every s2cloudless layer named in a URL, the 2016 edition too, whatever the profile (PT-23)', () => {
    const url = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg';
    expect(checkSource('d', 'fixture', xyz(url))?.profile).toBe('eox-s2cloudless');
    expect(checkSource('d', 'fixture', xyz(url.replace('s2cloudless-2020', 's2cloudless')))?.term).toMatch(
      /commercial licence/,
    );
  });
});
