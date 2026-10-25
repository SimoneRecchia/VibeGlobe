# 0181. Space background: catalog stars drawn procedurally and a procedural Milky Way, as a render extension

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-25
- Milestone: M11

## Context

The owner asked (2026-10-24) for an optional space background like Google Earth's, off by default: a star field and the
Milky Way behind the globe, fixed in the celestial frame (rotated by Greenwich sidereal time from the engine's date and
time, or a fixed epoch when none is set), so every camera move, globe spin or tilt moves the sky consistently; crisp at
any pixel ratio, without shimmering; fading out under the atmosphere's daytime sky near the ground and showing again at
night or from space. It is built by a parallel session as a render extension (`Globe.addRenderExtension`) in
`packages/renderer/src/starfield/`, with a helper `addSpaceBackground(globe, options)`, a playground toggle (`?stars=1`)
and its tests (F600–F609). Star data and any Milky Way image must have a public-domain or permissive license compatible
with MPL-2.0 (ADR 0043).

## Prior art (short survey)

- **Google Earth** shows stars and the Milky Way from space and hides them under the daytime sky; its sky turns with the
  Earth and follows the date and time when sunlight is on. Its assets are proprietary.
- **CesiumJS** draws a sky box: six cube-map images of the stars and Milky Way (from NASA's Tycho-2 based star maps),
  rotated by the ICRF-to-fixed transform each frame, and hides it where the sky atmosphere is bright. Images make the
  stars soft or aliased depending on the screen's pixel size versus the texel size, and cost several megabytes.
- **Planetarium software** (Stellarium and similar) draws catalog stars as point sprites whose size and brightness
  follow the magnitude, keeping a minimum footprint so stars do not twinkle as the view moves, and the Milky Way from
  an image.

The lesson for "crisp at any pixel ratio, no shimmering": stars drawn as sprites from a catalog, sized in device pixels
with a floor, look sharp on every display, while a texture's stars are tied to its texels.

## Options considered

1. **Stars.** (a) A cube-map or equirectangular image: one draw, but blurred or aliased depending on the pixel ratio,
   several megabytes, and the license of each available map must be checked (several recent ones include ESA Gaia data
   under CC BY-SA 3.0 IGO, whose share-alike terms bind the asset). (b) Catalog stars drawn as Gaussian sprites: needs a
   public-domain catalog. Candidates: the Yale Bright Star Catalog, 5th revised edition (BSC5; 9,110 objects to about
   magnitude 6.5; distributed by NASA's Astronomical Data Center and CDS as catalog V/50; public domain), Hipparcos (ESA;
   terms of use of ESA's archive), HYG (CC BY-SA: share-alike, rejected).
2. **Milky Way.** (a) An image: NASA SVS "Deep Star Maps" (NASA media, but the 2020 edition includes Gaia data under CC
   BY-SA 3.0 IGO), ESO's panorama (CC BY 4.0, with on-screen attribution), ESA's Gaia map (CC BY-SA 3.0 IGO); each is
   megabytes and adds attribution or share-alike obligations. (b) Procedural: a band along the galactic plane in a
   shader, shaped by published structure (wider and brighter toward the galactic center, the bulge, the dust lane), no
   asset and no license.
3. **Where it plugs in.** (a) Inside the renderer's frame loop, like the atmosphere. (b) A render extension: no change
   to `core` or the loop, which the parallel-session rules require.

## Decision

1. **Stars: BSC5 rendered procedurally.** The 9,096 catalog stars with a visual magnitude are encoded in
   `star-catalog-data.ts` (6 bytes a star, brightest first: right ascension as u16 of a turn, declination as i16 of
   90°, (V + 2) × 25 as u8, log temperature from 2,000 K to 50,000 K as u8; 72 KB of base64), decoded once.
   - Source: the JSON conversion `bsc5-short.json` of github.com/brettonw/YaleBrightStarCatalog (MIT, © 2016 Bretton
     Wade; file SHA-256 `94b0581379ef9ea49f1ce664734a06d2fbbff2d7487f926acad3e9ef0960e0d8`), which carries BSC5's J2000
     positions, V magnitudes and a color temperature derived from B−V. The catalog itself is public domain (scientific
     data distributed by NASA's archives without restriction); the conversion is MIT, so `THIRD_PARTY_NOTICES.md`
     records both (`scripts/release/assets.json`). The NASA and CDS distribution pages were not reachable from the
     build container (its proxy refuses them); the license reading is from the catalog's documentation as mirrored in
     the conversion's README.
   - Regenerating: parse each entry's `RA` (`hh mm ss.s`), `Dec` (`±dd° mm′ ss″`), `V` and `K` (5,800 K when missing),
     sort by V, pack as above, and write the base64 string as `STAR_CATALOG_BASE64`.
   - Each star is a sprite of four vertices: a Gaussian whose radius is 0.5 CSS px (more for stars brighter than
     magnitude 3) and never under 0.75 device px, and whose peak keeps the star's light in CSS pixels the same at every
     pixel ratio (`starSprite`). At 0.75 px the sum of a Gaussian's pixels varies by under 10⁻⁴ as it moves by a fraction
     of a pixel, so stars never shimmer. The light follows the magnitude at 0.6 of Pogson's slope, as photographs do, so
     an 8-bit display shows both Sirius and magnitude-6 stars. Colors are black-body radiance at 610, 550 and 465 nm,
     half-way toward white.
2. **Milky Way: procedural.** A full-screen backdrop computes each pixel's ray in galactic axes (Hipparcos's rotation
   matrix) and draws a Gaussian disk widening and brightening toward the galactic center, a bulge, a dust lane along the
   inner plane, and clumps from value noise of a few degrees, faint (at most 0.045 linear). No image ships.
3. **Orientation.** `celestialToEcef(t)` = R3(GMST) · P(t): precession from J2000 (IAU 1976, Lieske) and Greenwich mean
   sidereal time (Meeus, ch. 12), with UTC for UT1; nutation (under 20″) and polar motion are left out. The sky time is
   `Globe.atmosphere.timeMs` (the engine's date and time; its default is a fixed epoch, the 2026 June solstice at noon
   UTC), unless the `timeMs` option sets one. The stars' clip matrix is `projection · rotation(view) · celestialToEcef`
   (directions: the eye's position drops out), so every camera move, spin or tilt turns the sky with the globe.
4. **Visibility.** Opacity 1 without the atmosphere's sky. With it: 1 above 120 km or where the Sun is below −10° at the
   eye, faded toward 0 under 20 km in daylight (sun lighting off means the engine's sky is day everywhere). A flat map
   seen from above 20 km hides the background as it morphs flat (a world map has no sky); near the ground the flat map
   lies in the tangent plane at its anchor (ADR 0008), so the sky stays right there.
5. **Compositing.** Both meshes sit at the far end of the depth range like the atmosphere's sky (ADR 0005, both depth
   paths) and use one-one blending: the stars add premultiplied light only; the backdrop adds the Milky Way's light and
   the background's opacity to alpha, so over a transparent canvas space is black where it shows (the page's color
   elsewhere), and over the atmosphere's opaque sky the light just adds.
6. **API.** `addSpaceBackground(globe, { stars, milkyWay, brightness, timeMs, fade })` from
   `@vibeglobe/renderer/starfield` returns a handle with `setOptions`, `visibility`, `skyTimeMs` and `remove()`. Off
   unless added. three.js and the meshes load on demand (nothing touches the GPU at import time).
7. **Cost budget.** At most 0.5 ms of main-thread time per frame (the per-frame work is a 3 × 3 rotation when the time
   changes, two matrix products and a few uniforms) and a frame rate at least 80 % of the rate without it on CI's
   software GPU (F609).

## Consequences

- No image asset and no attribution on screen; the only third-party data is the 72 KB catalog, recorded in the notices.
- The faintest stars are those of BSC5 (about magnitude 6.5–8): denser star fields would need a larger catalog
  (Tycho-2 is public too, about 2.5 million stars) and a level-of-detail scheme — a follow-up, not needed now.
- Reading `Globe.atmosphere` and `Globe.qualitySettings` each frame allocates two small objects; a non-allocating read
  is requested as a hook (`docs/parallel-tracks.md`, "Hook requests").
- The `./starfield` subpath export, the baseline workflow's step for `e2e/starfield.spec.ts` and the notices row are
  edits outside the track's folder, proposed in its pull request and listed as hook requests.
