// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * VibeGlobe in one call: {@link createVibeGlobe} starts the globe in an element with the application's services, a
 * {@link TileService} (required), a {@link TerrainSource} and a {@link GeocoderService} (optional). The engine knows
 * no provider: any map, terrain or place search plugs in by implementing these interfaces (ADR 0186).
 * @module vibeglobe
 */
export { createVibeGlobe } from './create-vibe-globe.js';
export type { VibeGlobe, VibeGlobeOptions } from './create-vibe-globe.js';
export type { GeocoderResult, GeocoderService, Globe, TerrainSource, TileService } from '@vibeglobe/core';
