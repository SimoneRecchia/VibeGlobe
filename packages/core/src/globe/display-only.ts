// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { CreditProfile } from '../imagery/credits.js';
import { shownOpacity } from '../imagery/imagery-stack.js';
import { GlobeError } from './errors.js';
import type { ImageryRuntime } from './imagery-runtime.js';
import { extensionCredits } from './runtime-credits.js';

/** A source as its provider profile describes it. */
interface ProfiledSource {
  readonly id: string;
  readonly profile?: CreditProfile;
}

/** The refusal of a data-access API for a display-only source (F323, ADR 0031): its terms allow drawing, nothing else. */
function refusal(api: string, source: ProfiledSource): GlobeError {
  const rule = source.profile?.id === undefined ? 'its provider profile' : `the '${source.profile.id}' profile`;
  return new GlobeError(
    'display-only',
    `${api} is refused: source '${source.id}' is display only under ${rule} (profile.displayOnly; ADR 0031)`,
  );
}

/**
 * Throws when `api` would read the data of a display-only source (F323): pixel readback while such a layer is drawn
 * (`imagery`), and elevation sampling of such a terrain source (`terrain`).
 */
export function refuseDisplayOnly(
  runtime: ImageryRuntime | undefined,
  api: string,
  reads: 'imagery' | 'terrain',
): void {
  if (!runtime) return;
  const terrain = runtime.terrain?.source as ProfiledSource | undefined;
  if (terrain?.profile?.displayOnly === true) throw refusal(api, terrain);
  if (reads === 'terrain') return;
  for (const layer of runtime.stack) {
    if (!layer.entry.visible || shownOpacity(layer.entry) <= 0) continue;
    for (const { source } of layer.chain) if (source.profile?.displayOnly === true) throw refusal(api, source);
  }
}

/**
 * Throws when `api` would read the data of `source`, a display-only source that a render extension draws itself, such
 * as a provider's 3D Tiles (F323, F676; track E hook 6).
 */
export function refuseDisplayOnlySource(api: string, source: ProfiledSource): void {
  if (source.profile?.displayOnly === true) throw refusal(api, source);
}

/** Throws when `api` would read pixels back while a render extension draws a display-only source's content. */
export function refuseExtensionReadback(api: string, renderer: object | undefined): void {
  if (!renderer) return;
  for (const sources of extensionCredits.get(renderer)?.values() ?? [])
    for (const source of sources) refuseDisplayOnlySource(api, source);
}
