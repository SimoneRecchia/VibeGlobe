// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// `@vibeglobe/renderer/starfield`: the optional space background, stars and the Milky Way (ADR 0181).
export { addSpaceBackground } from './space-background.js';
export type {
  SpaceBackground,
  SpaceBackgroundGlobe,
  SpaceBackgroundInit,
  SpaceBackgroundOptions,
} from './space-background.js';
export { celestialToEcef, greenwichSiderealTimeRad } from './sky-orientation.js';
