// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { BackendChoice, DepthChoice } from './three-backend.js';

/** How a backend is set up: the `RendererOptions` it uses. */
export interface BackendSettings {
  readonly choice: BackendChoice;
  readonly depth: DepthChoice;
  /** Measures each frame's GPU time with timestamp queries where the device offers them (benchmarks only). */
  readonly gpuTiming: boolean;
  /** Multisampled anti-aliasing of the canvas (F397). */
  readonly antialias: boolean;
  /** The compressed families KTX2 imagery may use, among the device's; undefined for all of them. */
  readonly compressedTextures: readonly string[] | undefined;
}
