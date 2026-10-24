/**
 * Layer point projection for renderers (`@vibeglobe/core/layers`): a layer point's place on the globe, the flat map
 * and their morph, for picking and placing models. The engine's own frame needs none of it, so it stays out of the
 * main entry; the vertex writers the layer packages share stay there.
 * @packageDocumentation
 * @module @vibeglobe/core/layers
 */
export { projectLayerPoint } from './layers/layer-geometry.js';
