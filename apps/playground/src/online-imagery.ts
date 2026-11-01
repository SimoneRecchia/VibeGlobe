// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { AddedSource } from '@vibeglobe/presets';
import { xyzImagery } from '@vibeglobe/sources';

/**
 * The online imagery the person running the playground connects through its build variables (F683):
 * `VITE_ONLINE_IMAGERY_URL`, a tile URL template with `{z}`, `{x}` and `{y}` and their own key (in `.env.local`, never
 * committed), and `VITE_ONLINE_IMAGERY_CREDIT`, the credit the provider's terms ask for. It shows worldwide from level
 * 12 to 19 above the preset's sources; below level 12 the preset's free sources (and the app's offline package) show.
 * Nothing is added when no URL is set. VibeGlobe ships no provider and grants no right to any map data: whoever sets
 * the variables chooses the provider, holds its key and keeps to its terms (ADR 0185). The preset asks it from the
 * network only, never from the offline package.
 */
export function onlineImagery(env: Readonly<Record<string, string | undefined>>): AddedSource | undefined {
  const url = env['VITE_ONLINE_IMAGERY_URL'];
  if (!url) return undefined;
  const credit = { text: env['VITE_ONLINE_IMAGERY_CREDIT'] ?? new URL(url).host };
  return {
    source: xyzImagery({
      id: 'online-imagery',
      url,
      minLevel: 12,
      attribution: [credit],
      profile: { id: 'online-imagery', requiredAttribution: credit, respectCacheHeaders: true },
    }),
    record: {
      id: 'online-imagery',
      name: 'Online imagery of your choice',
      kind: 'imagery',
      tiers: 'network',
      license: "The provider's terms, accepted by whoever set its key",
      termsUrl: new URL(url).origin,
      termsReadDate: '',
      attribution: [credit],
      minLevel: 12,
      maxLevel: 19,
      coverage: 'world',
      url,
    },
  };
}
