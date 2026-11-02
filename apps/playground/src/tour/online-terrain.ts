// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `?showcase=1&terrain=mapterhorn`: the Europe preset's online terrain (Mapterhorn's Terrarium tiles), which the tour's
 * Real terrain scene reloads the page with once the visitor agrees to go online. Loaded only then.
 */
import type { GlobeOptions } from '@vibeglobe/core';
import { europeOpen } from '@vibeglobe/presets';
import { createWorkers } from '@vibeglobe/worker';

const terrain = europeOpen().terrain;

/** The globe's terrain and the workers that decode it. */
export const onlineTerrain: Pick<GlobeOptions, 'terrain' | 'workers'> = terrain
  ? { terrain, workers: createWorkers() }
  : {};
