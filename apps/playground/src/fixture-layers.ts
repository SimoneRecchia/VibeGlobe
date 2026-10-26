// Fixture imagery layers of the playground beyond `?imagery=`: overlays (F243–F246) and the fixture credits (F254, F255).
import type { ImageryBlend, ImageryLayerOptions, ImagerySource, TileRectangleRad } from '@vibeglobe/core';
import { fetchTransport, xyzImagery, type FetchTransportExtras, type XyzImageryOptions } from '@vibeglobe/sources';

/** A small logo for required credits (F255). */
const CREDIT_LOGO =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="14"><rect width="28" height="14" rx="3" fill="#1a73e8"/></svg>',
  );

/**
 * The credits of a fixture source: `Fixture <pattern>` with a link; with `?requiredCredit=<source id>` that source's
 * provider also requires a credit with a logo (F254, F255).
 */
export function credits(
  params: URLSearchParams,
  id: string,
  pattern: string,
): Pick<XyzImageryOptions, 'attribution' | 'profile'> {
  const required = params.get('requiredCredit') === id;
  return {
    attribution: [{ text: `Fixture ${pattern}`, url: `https://example.com/fixtures/${pattern}` }],
    ...(required
      ? {
          profile: {
            requiredAttribution: { text: `Required ${pattern}`, logo: { src: CREDIT_LOGO, alt: `${pattern} logo` } },
          },
        }
      : {}),
  };
}

/** A triangle over Italy, 0°–24° E and 35°–52° N, whose long side crosses 12° E at 43.5° N (KB-209). */
const TRIANGLE = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 35],
      [24, 35],
      [0, 52],
      [0, 35],
    ],
  ],
} as const;

/**
 * `?overlays=<pattern>[:<opacity>[:<blend>]],…` adds fixture layers above `?imagery=`, bottom first, each with its
 * opacity and blend mode (F243–F246); their ids are `overlay-<pattern>`.
 */
export function overlayLayers(
  params: URLSearchParams,
  base: string,
  session: string,
  tiling: 'mercator' | 'geographic',
  italy: TileRectangleRad,
): ImageryLayerOptions[] {
  const spec = params.get('overlays');
  if (!spec) return [];
  // `?overlayHosts=<base>,…` serves each overlay from another base URL, such as another origin (F251, F252).
  const hosts = (params.get('overlayHosts') ?? '').split(',');
  // `?overlayTiling=` cuts the overlays in another scheme than the base imagery (F225).
  const scheme = params.get('overlayTiling');
  const overlayTiling = scheme === 'geographic' || scheme === 'mercator' ? scheme : tiling;
  return spec.split(',').map((item, index) => {
    const [pattern = 'tiles', opacity = '1', blend = 'normal'] = item.split(':');
    const host = hosts[index] || base;
    const source = xyzImagery({
      id: `overlay-${pattern}`,
      url: `${host}fixture-tiles/${session}/${pattern}/${overlayTiling}/{z}/{x}/{y}.${imageFormat(params, 'overlayFormat')}`,
      // The `holes` pattern's transparent cells show the layers below (F242).
      ...(pattern === 'holes' ? { transparent: true } : {}),
      ...overlayTransport(params, host, pattern),
      tiling: overlayTiling,
      minLevel: 0,
      maxLevel: 18,
      // `?overlayCoverage=italy` limits the overlays to a box around Italy (F254).
      ...(params.get('overlayCoverage') === 'italy' ? { coverage: [italy] } : {}),
      // `?overlayArea=triangle` limits them to a triangle over Italy as GeoJSON, clipped per pixel (F618, KB-209).
      ...(params.get('overlayArea') === 'triangle' ? { area: TRIANGLE } : {}),
      // `?overlayBlank=rrggbb`: tiles of that color only count as no data (F618).
      ...(params.get('overlayBlank') ? { blankTile: `#${params.get('overlayBlank') ?? ''}` } : {}),
      ...credits(params, `overlay-${pattern}`, pattern),
    });
    return { sources: [source], opacity: Number(opacity), blend: blend as ImageryBlend };
  });
}

/**
 * The overlays' transport security options (F251–F253): `?overlayAuth=1` sends `Authorization: Bearer <pattern>-<n>`
 * to the overlay's own origin only, `n` counting renewals; `?overlayCredentials=` sets the fetch credentials mode;
 * `?overlayKey=` adds a `key` query parameter at fetch time only.
 */
function overlayTransport(
  params: URLSearchParams,
  host: string,
  pattern: string,
): Pick<XyzImageryOptions, 'transport'> {
  const key = params.get('overlayKey');
  const mode = params.get('overlayCredentials');
  let renewals = 1;
  const extras: FetchTransportExtras = {
    ...(params.get('overlayAuth') === '1'
      ? {
          auth: {
            origins: [new URL(host, location.href).origin],
            headers: () => ({ Authorization: `Bearer ${pattern}-${String(renewals)}` }),
            refresh: () => Promise.resolve(void renewals++),
          },
        }
      : {}),
    ...(key ? { secretQuery: () => ({ key }) } : {}),
    ...(mode === 'include' || mode === 'omit' || mode === 'same-origin' ? { credentials: mode } : {}),
  };
  return Object.keys(extras).length > 0 ? { transport: fetchTransport(undefined, undefined, extras) } : {};
}

/**
 * `?chain=<pattern>[:<maxLevel>[:italy]],…` makes `?imagery=` the first source of a chain whose next sources are these
 * fixture patterns, in priority order (F247, F248); their ids are `chain-<pattern>`. With `?timeoutMs=` every
 * source gives up on a request after that long.
 */
export function chainSources(
  params: URLSearchParams,
  base: string,
  session: string,
  tiling: 'mercator' | 'geographic',
  italy: TileRectangleRad,
): ImagerySource[] {
  const spec = params.get('chain');
  if (!spec) return [];
  const timeoutMs = params.has('timeoutMs') ? Number(params.get('timeoutMs')) : undefined;
  return spec.split(',').map((item) => {
    const [pattern = 'levels', maxLevel = '18', coverage] = item.split(':');
    return xyzImagery({
      id: `chain-${pattern}`,
      url: `${base}fixture-tiles/${session}/${pattern}/${tiling}/{z}/{x}/{y}.png`,
      tiling,
      minLevel: 0,
      maxLevel: Number(maxLevel),
      ...(coverage === 'italy' ? { coverage: [italy] } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutsMs: { firstByteMs: timeoutMs, totalMs: timeoutMs } }),
      ...credits(params, `chain-${pattern}`, pattern),
    });
  });
}

/**
 * The fixture imagery's tile size and URL suffix: `?imageryTileSize=512` serves the same tiles at 512 pixels (F240),
 * `?imageryHiDpi=1` adds `@2x` variants through the `{r}` template field (F241); `rows` addresses the tiles.
 */
export function tileVariant(params: URLSearchParams): { tileSizePx: number; variant: string; rows: string } {
  const tileSizePx = params.get('imageryTileSize') === '512' ? 512 : 256;
  const variant = tileSizePx === 512 ? '@2x' : params.get('imageryHiDpi') === '1' ? '{r}' : '';
  // `?imageryAddressing=tms` requests Web Mercator tiles with TMS rows from the fixture's `mercator-tms` (F229).
  const rows = params.get('imageryAddressing') === 'tms' ? '-tms/{z}/{x}/{-y}' : '/{z}/{x}/{y}';
  return { tileSizePx, variant, rows };
}

/** `?imageryFormat=jpg|webp|avif` (or `?overlayFormat=` for the overlays, under `name`) serves another format (F242). */
function imageFormat(params: URLSearchParams, name = 'imageryFormat'): string {
  const format = params.get(name);
  return format === 'jpg' || format === 'webp' || format === 'avif' ? format : 'png';
}

/** The fixture imagery's file extension: `?ktx2=etc1s|uastc` serves KTX2 tiles with a full mip chain (F104). */
export function imageExtension(params: URLSearchParams): string {
  const ktx2 = params.get('ktx2');
  return ktx2 === 'etc1s' || ktx2 === 'uastc' ? `${ktx2}.ktx2` : imageFormat(params);
}
