/**
 * The material of raster meshes (F445, ADR 0133): a tile square that follows the globe, the morph and the terrain like
 * a fill, textured with the tile's image (raster tiles, hillshade shading, heatmap colors). Raster paint is applied in
 * sRGB before the conversion to linear light: saturation, contrast, then the brightness range, and the opacity.
 */
import type { DepthPath } from '@vibeglobe/core';
import {
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  float,
  max,
  mix,
  positionGeometry,
  texture,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  MeshBasicNodeMaterial,
  RGBAFormat,
  UnsignedByteType,
  type Texture,
} from 'three/webgpu';
import {
  createUniforms,
  DEPTH_PULL,
  finish,
  ground,
  insideClip,
  linearRgba,
  mixAB,
  placed,
} from './vector-material.js';

/** The tile's units per side (the vector tile extent the tile attribute is in). */
const EXTENT = 4096;

/** A texture of a raster image (straight sRGB RGBA, top row first). */
export function rasterTexture(image: {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}): Texture {
  const data = image.data instanceof Uint8Array ? image.data : new Uint8Array(image.data.buffer);
  const t = new DataTexture(data, image.width, image.height, RGBAFormat, UnsignedByteType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** A raster mesh's material over its texture; frame uniforms as `createVectorMaterial`'s (`setVectorFrame`). */
export function createRasterMaterial(image: Texture, depthPath: DepthPath): MeshBasicNodeMaterial {
  const u = createUniforms();
  const here = placed(
    positionGeometry,
    attribute('tileNormal', 'vec3'),
    attribute('tilePlane', 'vec4'),
    ground(),
    float(0),
    u,
    DEPTH_PULL,
  );
  const viewPosition = cameraViewMatrix.mul(vec4(here, 1));
  const material = new MeshBasicNodeMaterial();
  material.vertexNode = cameraProjectionMatrix.mul(viewPosition);
  const uv = clamp(varying(attribute('vtTile', 'vec2')).div(EXTENT), 0, 1);
  const sample = texture(image, uv);
  // params: brightness min, brightness max, saturation, contrast (−1 to 1); color.w: opacity.
  const params = varying(mixAB('vtParams', u));
  const opacity = varying(mixAB('vtColor', u)).w;
  const gray = vec3(sample.x.add(sample.y).add(sample.z).div(3));
  const saturated = mix(gray, sample.xyz, float(1).add(params.z));
  const contrast = params.w
    .greaterThan(0)
    .select(float(1).div(max(float(1).sub(params.w), 1e-3)), float(1).add(params.w));
  const contrasted = saturated.sub(0.5).mul(contrast).add(0.5);
  const bright = mix(vec3(params.x), vec3(params.y), clamp(contrasted, 0, 1));
  const color = linearRgba(vec4(bright, sample.w));
  material.colorNode = vec4(color.xyz, color.w.mul(opacity).mul(u.layer.x).mul(insideClip(u)));
  material.userData['vectorUniforms'] = u;
  return finish(material, viewPosition, depthPath, false);
}
