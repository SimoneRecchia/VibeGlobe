// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Attribution, ImageryLayerOptions, PolarCapColors } from '@vibeglobe/core';
import { mercatorImage } from './mercator-image.js';

/**
 * The world by day, shipped with the package (ADR 0194): NASA Blue Marble with shaded relief and bathymetry (public
 * domain, from NASA GIBS), equirectangular, 4096 × 2048 pixels in WebP (0.85 MB), sharp to about level 4. It is the
 * base image of `createVibeGlobe` and of the Vue component when they are given none; bundlers copy it to the
 * application's assets from `src/earth/day.webp`, next to this module in the package.
 */
export const dayImageUrl = (): string => new URL('../src/earth/day.webp', import.meta.url).href;

/** The credit of {@link dayImageUrl}'s image. */
export const DAY_IMAGE_CREDIT: Attribution = {
  text: "Imagery: NASA Blue Marble, from NASA's Global Imagery Browse Services (GIBS), part of NASA's ESDIS",
  url: 'https://www.earthdata.nasa.gov/gibs',
};

/** The polar caps that continue {@link dayImageUrl}'s image beyond ±85.05°: its deep sea north, its ice south. */
export const DAY_IMAGE_POLAR_CAPS: PolarCapColors = { north: '#0e295a', south: '#eeefef' };

/**
 * City lights by night, shipped with the package: NASA Black Marble 2016 (VIIRS, public domain) in Web Mercator,
 * 2048 × 2048 pixels in WebP (0.1 MB), from `src/earth/night.webp`.
 */
export const nightImageUrl = (): string => new URL('../src/earth/night.webp', import.meta.url).href;

/** The id of the {@link nightLights} layer, to show or hide it with `globe.imageryLayers.set`. */
export const NIGHT_LIGHTS_ID = 'night-lights';

/** Levels cut at full resolution from a 2048-pixel image: it is seen only from afar. */
const NIGHT_LEVELS = 3;

/**
 * The night side's city lights as an imagery layer (`blend: 'night'`, shown with `AtmosphereSettings.dayNight`): the
 * shipped Black Marble, or `image`, the application's own Web Mercator image of the whole world.
 */
export function nightLights(image: string = nightImageUrl()): ImageryLayerOptions {
  return {
    id: NIGHT_LIGHTS_ID,
    blend: 'night',
    harmonize: false,
    sources: [
      mercatorImage({
        id: NIGHT_LIGHTS_ID,
        image,
        maxLevel: NIGHT_LEVELS,
        attribution: [
          { text: 'Night lights: NASA Black Marble', url: 'https://earthobservatory.nasa.gov/features/NightLights' },
        ],
      }),
    ],
  };
}
