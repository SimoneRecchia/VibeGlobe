// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * Framework-neutral `<vibe-globe>` custom element. Importing the package has no side effects: the element is
 * registered by an explicit {@link defineVibeGlobe} call, under a configurable tag name.
 * @module @vibeglobe/web-component
 */
export { defineVibeGlobe } from './vibe-globe-element.js';
export type { CenterDeg, VibeGlobeElement, VibeGlobeEventDetail } from './vibe-globe-element.js';
export type { GlobeClickEvent } from './click.js';
