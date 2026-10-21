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
    expect(checkSource('d', 'fixture', xyz('https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}'))?.profile).toBe(
      'google-maps-platform',
    );
    const s2 = (edition: number): SourceConfig => ({
      type: 's2cloudless',
      baseUrl: 'https://b.test',
      edition,
      level: 13,
      requesterPays: true,
    });
    expect(checkSource('d', 's2cloudless-2016', s2(2016))).toBeUndefined();
    expect(checkSource('d', 's2cloudless-2016', s2(2020))?.term).toMatch(/2018 and later editions/);
    expect(
      checkSource('d', 'openstreetmap-extract', {
        type: 'osm-extract',
        url: 'https://download.geofabrik.de/europe/italy-latest.osm.pbf',
      }),
    ).toBeUndefined();
  });
});
