// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The fill of the polar caps beyond ±85.0511° that no imagery source covers (KB-211, ADR 0008 update 2026-10-26): the
 * draw list gives such cap tiles the imagery handle -2 (north) or -3 (south), which the renderer draws in these colors.
 */

/** The fill colors of the polar caps where no imagery source covers them: CSS hex colors, `#rrggbb`. */
export interface PolarCapColors {
  /** Default `#78a9cd`, the sea of the Natural Earth base image. */
  readonly north?: string;
  /** Default `#f2f3f7`, the ice of the Natural Earth base image. */
  readonly south?: string;
}
