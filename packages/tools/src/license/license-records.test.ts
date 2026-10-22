import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_DIR } from '../cli.js';
import { loadConfig } from '../config/load.js';
import { outputMetadata } from '../output/metadata.js';
import { PROVIDER_PROFILES } from './profiles.js';

const docs = new URL('../../../../docs/', import.meta.url);
const adr = readFileSync(new URL('adr/0025-default-data-licenses.md', docs), 'utf8');
const licensesDoc = readFileSync(new URL('data-licenses.md', docs), 'utf8');
const configs = readdirSync(CONFIG_DIR)
  .filter((f) => f.endsWith('.json') && !f.endsWith('.lock.json'))
  .map((f) => loadConfig(join(CONFIG_DIR, f)).config);

describe('license records', () => {
  it.each(PROVIDER_PROFILES.filter((p) => p.id !== 'fixture'))('ADR 0025 records profile $id', (profile) => {
    const row = adr.split('\n').find((line) => line.startsWith(`| \`${profile.id}\``));
    expect(row, `a row for ${profile.id}`).toBeDefined();
    expect(row).toContain(profile.termsReadDate);
    if (profile.offlinePackaging) expect(row).toContain(`\`${profile.attribution}\``);
    else expect(row).toMatch(/refused/);
  });

  it('the shipped configurations use only profiles whose attribution ADR 0025 records', () => {
    for (const config of configs) {
      for (const dataset of config.datasets) {
        const metadata = outputMetadata(config, dataset, { west: 0, south: 0, east: 1, north: 1 });
        expect(adr).toContain(`\`${metadata.attribution}\``);
      }
    }
  });

  it('the data licenses document matches the license metadata the pipeline emits (F345)', () => {
    for (const config of configs) {
      for (const dataset of config.datasets) {
        const metadata = outputMetadata(config, dataset, { west: 0, south: 0, east: 1, north: 1 });
        const row = licensesDoc.split('\n').find((line) => line.includes(metadata.attribution));
        expect(row, `${config.name}/${dataset.id}`).toBeDefined();
        expect(row).toContain(`\`${config.name}\``);
        expect(row).toContain(metadata.license);
        for (const source of metadata.sources) {
          expect(row).toContain(source.url);
          expect(row).toContain(source.termsReadDate);
        }
      }
    }
    const raw = PROVIDER_PROFILES.find((p) => p.id === 'copernicus-sentinel-2');
    expect(licensesDoc).toContain(raw?.attribution);
  });
});
