// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { ImageryLayerInput, TileService } from '@vibeglobe/core';

/** OpenFreeMap's vector maps of OpenStreetMap, without a key; the style carries its credits (ADR 0186). */
export class OpenFreeMapTiles implements TileService {
  readonly #style: string;

  /** `style`: 'liberty' (default), 'bright' or 'positron'. */
  constructor(options: { readonly style?: 'liberty' | 'bright' | 'positron' } = {}) {
    this.#style = options.style ?? 'liberty';
  }

  /** None: the map is all vector. */
  imagery(): readonly ImageryLayerInput[] {
    return [];
  }

  /** The style's URL. */
  style(): string {
    return `https://tiles.openfreemap.org/styles/${this.#style}`;
  }
}
