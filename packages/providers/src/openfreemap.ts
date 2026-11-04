// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { TileService } from '@vibeglobe/core';

/** OpenFreeMap's vector map of OpenStreetMap, without a key: `style` 'liberty' (default), 'bright' or 'positron'. */
export function openFreeMapTiles({
  style = 'liberty',
}: { readonly style?: 'liberty' | 'bright' | 'positron' } = {}): TileService {
  return { imagery: [], style: `https://tiles.openfreemap.org/styles/${style}` };
}
