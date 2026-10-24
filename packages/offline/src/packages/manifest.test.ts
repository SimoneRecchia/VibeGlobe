import { describe, expect, it } from 'vitest';
import { PackageError, validateManifest } from './manifest.js';

describe('validateManifest on malformed entries (TG-02)', () => {
  it('reports a null or non-object file or source entry as an invalid manifest, never a TypeError', () => {
    const file = { path: 'a.pmtiles', format: 'pmtiles', bytes: 1, sha256: 'a'.repeat(64) };
    for (const manifest of [
      { id: 'a', version: '1', area: {}, files: [null], sources: [{}] },
      { id: 'a', version: '1', area: {}, files: [7], sources: [] },
      { id: 'a', version: '1', area: {}, files: [file], sources: [null] },
    ])
      expect(() => validateManifest(manifest)).toThrow(PackageError);
  });
});
