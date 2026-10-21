import type { DepthPath, TileDrawList } from '@vibeglobe/core';
import { attribute, mix, texture, uniform, vec2 } from 'three/tsl';
import { DoubleSide, MeshBasicNodeMaterial, Vector4, type Object3D, type Texture } from 'three/webgpu';
import { makeEyeRelative } from './eye-relative.js';

/** What one surface tile draws this frame: set on its mesh before each frame, read by the shared material. */
export interface SurfaceDraw {
  /** Set by every frame that draws the mesh, before it draws. */
  texture: Texture | undefined;
  /** Scale u, scale v, offset u, offset v from tile coordinates into the texture's (TileDrawList). */
  readonly transform: Vector4;
  /** 1 when the texture's rows are linear in latitude, 0 when they follow the tile's own rows. */
  geographic: number;
}

/** The draw state of a surface mesh, created with the mesh. */
function surfaceDrawOf(object: Object3D | null): SurfaceDraw | undefined {
  return object?.userData['surfaceDraw'] as SurfaceDraw | undefined;
}

/** Attaches a draw state to a new surface mesh. */
export function attachSurfaceDraw(object: Object3D): SurfaceDraw {
  const draw: SurfaceDraw = { texture: undefined, transform: new Vector4(1, 1, 0, 0), geographic: 1 };
  object.userData['surfaceDraw'] = draw;
  return draw;
}

/**
 * The surface material shared by every tile: one shader and one pipeline for the whole surface (ADR 0010 §4, §7).
 * The texture, its UV transform and the choice of v are object-scope uniforms read from each mesh's
 * {@link SurfaceDraw}, so tiles drawing different imagery tiles still share the material. `placeholder` only fixes the
 * texture binding's type.
 */
export function createSurfaceMaterial(placeholder: Texture, depthPath: DepthPath): MeshBasicNodeMaterial {
  const tileUv = attribute('tileUv', 'vec3');
  const transform = uniform(new Vector4(1, 1, 0, 0)).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.transform);
  const geographic = uniform(1).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.geographic);
  const v = mix(tileUv.y, tileUv.z, geographic);
  const uv = vec2(tileUv.x.mul(transform.x).add(transform.z), v.mul(transform.y).add(transform.w));
  const material = new MeshBasicNodeMaterial();
  material.colorNode = texture(placeholder, uv).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.texture);
  makeEyeRelative(material, depthPath);
  // Skirts face outward on some edges; drawing both sides keeps every crack filled.
  material.side = DoubleSide;
  return material;
}

/** Points a mesh's draw state at draw `i` of a frame's list, sampling `texture`. */
export function applyDraw(draw: SurfaceDraw, draws: TileDrawList, i: number, texture: Texture): void {
  draw.texture = texture;
  draw.geographic = draws.geographic[i] ?? 1;
  const at = i * 4;
  draw.transform.set(
    draws.uvTransforms[at] ?? 1,
    draws.uvTransforms[at + 1] ?? 1,
    draws.uvTransforms[at + 2] ?? 0,
    draws.uvTransforms[at + 3] ?? 0,
  );
}
