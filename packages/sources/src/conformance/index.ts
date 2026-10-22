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
export { check, failures, faultyFetch, sameBytes } from './support.js';
export type { CheckResult, FaultMode } from './support.js';
