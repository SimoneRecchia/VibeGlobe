import type { DepthPath } from '@vibeglobe/core';
import { texture, uv } from 'three/tsl';
import { DoubleSide, MeshBasicNodeMaterial, type Texture } from 'three/webgpu';
import { makeEyeRelative } from './eye-relative.js';

/** The textured surface material shared by every tile: one shader for the whole surface. */
export function createSurfaceMaterial(baseImagery: Texture, depthPath: DepthPath): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.colorNode = texture(baseImagery, uv());
  makeEyeRelative(material, depthPath);
  // Skirts face outward on some edges; drawing both sides keeps every crack filled.
  material.side = DoubleSide;
  return material;
}
