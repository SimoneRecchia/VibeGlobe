// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Layer point projection for renderers (`@vibeglobe/core/layers`): a layer point's place on the globe, the flat map
 * and their morph, for picking and placing models. The engine's own frame needs none of it, so it stays out of the
 * main entry; the vertex writers the layer packages share stay there. The failure classes of ADR 0007 too, so the
 * vector tiles retry what the imagery and terrain retry.
 * @packageDocumentation
 * @module @vibeglobe/core/layers
 */
export { projectLayerPoint } from './layers/layer-geometry.js';
export { FAILURE_TRANSIENT, classifyTransportResult } from './scheduler/failure-policy.js';
