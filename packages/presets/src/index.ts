// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `@vibeglobe/presets`: ready map types built only from free sources whose terms allow commercial use and
 * redistribution, with each source's coverage, levels, licence and exact attribution (ADR 0182).
 *
 * @packageDocumentation
 */
export { europeOpen } from './europe.js';
export type {
  AddedSource,
  BaseMap,
  EuropeOpenOptions,
  EuropePreset,
  OfflineWrapper,
  Overlay,
  PresetMode,
} from './europe.js';
export { EUROPE_BOUNDS, EUROPE_LAND } from './europe-land.js';
export { EUROPE_SOURCES, EXCLUDED_SOURCES, TERMS_READ_DATE } from './sources.js';
export type { ExcludedSource, PresetSourceRecord, SourceTiers } from './sources.js';
export { composeStyle } from './styles.js';
export type { HillshadeSource, StyleJson, StyleLayerJson, StyleSelection } from './styles.js';
