// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The fill of the polar caps beyond ±85.0511° that no imagery source covers (KB-211, ADR 0008 update 2026-10-26). */
import { GlobeError } from './errors.js';

/** Imagery handle of the north cap's fill: a cap tile no imagery source covers shows the renderer's texture of it. */
export const NORTH_CAP_TEXTURE = -2;
/** Imagery handle of the south cap's fill. */
export const SOUTH_CAP_TEXTURE = -3;

/** The fill colors of the polar caps where no imagery source covers them: CSS hex colors (`#rgb` or `#rrggbb`). */
export interface PolarCapColors {
  /** Default `#78a9cd`, the sea of the Natural Earth base image. */
  readonly north?: string;
  /** Default `#f2f3f7`, the ice of the Natural Earth base image. */
  readonly south?: string;
}

/** An sRGB color as three 0–255 channels. */
export type Rgb = readonly [number, number, number];

/** The default fills: the sea and the ice of the Natural Earth base image at its poles. */
export const DEFAULT_CAP_COLORS: Required<PolarCapColors> = { north: '#78a9cd', south: '#f2f3f7' };

/** Parses a CSS hex color (`#rgb` or `#rrggbb`); throws a GlobeError ('invalid-option') naming the field otherwise. */
export function hexRgb(name: string, value: unknown): Rgb {
  const match = typeof value === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value) : null;
  if (!match?.[1])
    throw new GlobeError('invalid-option', `${name} must be a hex color like #78a9cd, got ${JSON.stringify(value)}`);
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
