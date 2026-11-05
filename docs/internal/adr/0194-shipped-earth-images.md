# 0194. Two images of the Earth ship with the package

- Status: Accepted
- Date: 2026-11-05
- Milestone: M7 (F712; partly supersedes ADR 0187 on the base image)

## Context

The owner's brief of 2026-11-05: the images of the world by day and by night move from the first application into the
library, so that they are the defaults an application starts with, and an application can still replace them. Until
now every integration hosted its own base image (`createVibeGlobe` fell back to one ocean color) and its own night
lights, and ADR 0187 kept every map out of the published packages.

## Decision

- `@vibeglobe/sources` ships two public-domain images under `src/earth/`, next to the module that resolves them with
  `new URL(…, import.meta.url)` as the star catalog does (ADR 0181), so bundlers copy them to the application's assets:
  - `day.webp`: NASA Blue Marble with shaded relief and bathymetry, from NASA GIBS, equirectangular, 4096 × 2048 pixels
    (0.85 MB), sharp to about level 4. `dayImageUrl()`, its credit `DAY_IMAGE_CREDIT` and the polar caps that continue
    it, `DAY_IMAGE_POLAR_CAPS`.
  - `night.webp`: NASA Black Marble 2016 (VIIRS) in Web Mercator, 2048 × 2048 pixels (0.1 MB). `nightImageUrl()` and
    `nightLights(image?)`, a `blend: 'night'` layer (`NIGHT_LIGHTS_ID`) cut from it, or from the application's image.
- `createVibeGlobe` and the Vue component start on the day image and its polar caps when given no `baseImageryUrl`; an
  application's own image keeps the engine's caps or the ones it passes. `createGlobe` and the Web Component still
  require a base image: the Web Component's browser bundle would inline the image.
- The two images are whole-world backdrops, not a map: the application still brings its tiles, terrain and places
  (ADR 0186, F701).

## Consequences

- An application needs no asset of its own to start, and the first application drops its copies.
- The package grows by about 0.96 MB, downloaded only by the applications that use the defaults: nothing loads the
  images unless `dayImageUrl()` or `nightLights()` is called.
