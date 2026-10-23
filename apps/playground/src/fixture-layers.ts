// Fixture imagery layers of the playground beyond `?imagery=`: overlays (F243–F246) and the fixture credits (F254, F255).
import type { ImageryBlend, ImageryLayerOptions, ImagerySource, TileRectangleRad } from '@vibeglobe/core';
import { xyzImagery, type XyzImageryOptions } from '@vibeglobe/sources';

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
  return spec.split(',').map((item) => {
    const [pattern = 'tiles', opacity = '1', blend = 'normal'] = item.split(':');
    const source = xyzImagery({
      id: `overlay-${pattern}`,
      url: `${base}fixture-tiles/${session}/${pattern}/${tiling}/{z}/{x}/{y}.png`,
      tiling,
      minLevel: 0,
      maxLevel: 18,
      // `?overlayCoverage=italy` limits the overlays to a box around Italy (F254).
      ...(params.get('overlayCoverage') === 'italy' ? { coverage: [italy] } : {}),
      ...credits(params, `overlay-${pattern}`, pattern),
    });
    return { sources: [source], opacity: Number(opacity), blend: blend as ImageryBlend };
  });
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
