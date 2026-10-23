import type { CreditProfile } from '../imagery/credits.js';
import { GlobeError } from './errors.js';
import type { ImageryRuntime } from './imagery-runtime.js';

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
    if (!layer.entry.visible || layer.entry.opacity <= 0) continue;
    for (const { source } of layer.chain) if (source.profile?.displayOnly === true) throw refusal(api, source);
  }
}
