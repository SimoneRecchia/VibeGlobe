/**
 * `?custom=quadkey` streams the imagery and terrain of a consumer's own adapter package outside `packages/`
 * (`scripts/fixtures/custom-adapters/`), attached through the public `GlobeOptions` only (F219). The tests answer the
 * adapters' quadkey service from the fixture tile server.
 */
import type { GlobeOptions } from '@vibeglobe/core';
import { createWorkers } from '@vibeglobe/worker';
import { quadkeyImagery } from '../../../scripts/fixtures/custom-adapters/quadkey-imagery.ts';
import { quadkeyTerrain } from '../../../scripts/fixtures/custom-adapters/quadkey-terrain.ts';

/** The custom adapters of the URL, if any. */
export function customAdapters(params: URLSearchParams): Pick<GlobeOptions, 'imagery' | 'terrain' | 'workers'> {
  if (params.get('custom') !== 'quadkey') return {};
  return { imagery: [quadkeyImagery()], terrain: quadkeyTerrain(), workers: createWorkers() };
}
