// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Emitter } from './emitter.js';
import type { GlobeError } from './errors.js';
import type { GlobeEvents, RendererEvents } from './types.js';

/**
 * The renderer's events as the globe reports them: device loss and restoration, backend fallback, and the failure
 * after which nothing is drawn any more, so a first frame that never came will not come (KB-036), nor a frame to
 * capture.
 */
export function rendererEvents(
  emitter: Emitter<GlobeEvents>,
  restored: () => void,
  failed: (error: GlobeError) => void,
): RendererEvents {
  return {
    deviceLost: (reason) => emitter.emit('device-lost', { reason }),
    deviceRestored: () => {
      restored();
      emitter.emit('device-restored', {});
    },
    backendFallback: (reason) => emitter.emit('backend-fallback', { reason }),
    failed,
  };
}
