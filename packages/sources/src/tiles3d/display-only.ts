/**
 * The display-only refusal of 3D Tiles data access (F323, ADR 0031) through core's `refuseDisplayOnly`, the one the
 * globe's own data-access APIs use: a render extension's source is passed as the only data source in view, so the
 * refusal is the same `GlobeError` 'display-only' naming the source and its profile. Hook request E (6) proposes a
 * signature for extensions' own sources.
 */
import { refuseDisplayOnly as refuseCore, type CreditProfile } from '@vibeglobe/core';

/** A source as its provider profile describes it. */
interface ProfiledSource {
  readonly id: string;
  readonly profile?: CreditProfile;
}

/** Throws when `api` would read the data of a display-only source: picking its features, reading its tile tree. */
export function refuseDisplayOnly(api: string, source: ProfiledSource): void {
  // Core reads the sources in view from the globe's imagery runtime: its terrain source first, then the drawn layers.
  const inView = { terrain: { source }, stack: [] } as unknown as Parameters<typeof refuseCore>[0];
  refuseCore(inView, api, 'terrain');
}
