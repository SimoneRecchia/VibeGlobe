// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * The shared adapter conformance suites (F223), importable by custom adapter packages as
 * `@vibeglobe/sources/conformance`: they need no test framework, and return every check with its outcome.
 * @module @vibeglobe/sources/conformance
 */
export { runParserConformance, mutate } from './parser.js';
export type { ParserConformanceSubject } from './parser.js';
export { runTiledConformance } from './tiled.js';
export type { TiledConformanceSubject } from './tiled.js';
export { runTerrainConformance } from './terrain.js';
export type { ReferenceHeight, TerrainConformanceSubject } from './terrain.js';
export { check, failures, faultyFetch, sameBytes } from './support.js';
export type { CheckResult, FaultMode } from './support.js';
