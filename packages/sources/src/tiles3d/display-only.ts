/**
 * The display-only refusal of 3D Tiles data access (F323, ADR 0031), the counterpart of core's `refuseDisplayOnly`
 * for a render extension's own source: the same `GlobeError` 'display-only' and message. Core's function reads the
 * globe's imagery runtime and is not exported; hook request E (6) asks for a form extensions can call, which then
 * replaces this one.
 */
import { GlobeError, type CreditProfile } from '@vibeglobe/core';

/** A source as its provider profile describes it. */
interface ProfiledSource {
  readonly id: string;
  readonly profile?: CreditProfile;
}

/** Throws when `api` would read the data of a display-only source: picking its features, reading its tile tree. */
export function refuseDisplayOnly(api: string, source: ProfiledSource): void {
  if (source.profile?.displayOnly !== true) return;
  const rule = source.profile.id === undefined ? 'its provider profile' : `the '${source.profile.id}' profile`;
  throw new GlobeError(
    'display-only',
    `${api} is refused: source '${source.id}' is display only under ${rule} (profile.displayOnly; ADR 0031)`,
  );
}
