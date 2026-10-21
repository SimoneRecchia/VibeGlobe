import type { DepthPath, TileDrawList } from '@vibeglobe/core';
import { attribute, Fn, If, mix, texture, uniform, vec2 } from 'three/tsl';
import { DataTexture, DoubleSide, MeshBasicNodeMaterial, Vector4, type Object3D, type Texture } from 'three/webgpu';
import { makeEyeRelative } from './eye-relative.js';

/** What one surface tile draws this frame: set on its mesh before each frame, read by the shared material. */
export interface SurfaceDraw {
  /** Set by every frame that draws the mesh, before it draws. */
  texture: Texture | undefined;
  /** Scale u, scale v, offset u, offset v from tile coordinates into the texture's (TileDrawList). */
  readonly transform: Vector4;
  /** 1 when the texture's rows are linear in latitude, 0 when they follow the tile's own rows. */
  geographic: number;
  /** The imagery the tile cross-fades from (F105): its texture, transform and choice of v. */
  fromTexture: Texture | undefined;
  readonly fromTransform: Vector4;
  fromGeographic: number;
  /** Fade progress: 0 shows only the `from` imagery, 1 only the tile's own. */
  fade: number;
}

/** The draw state of a surface mesh, created with the mesh. */
function surfaceDrawOf(object: Object3D | null): SurfaceDraw | undefined {
  return object?.userData['surfaceDraw'] as SurfaceDraw | undefined;
}

/**
 * Attaches a draw state to a new surface mesh. Its texture reaches the shared texture node just before the mesh is
 * drawn: three.js resets a texture node's update type when it builds the shader, so a per-object update on the node
 * itself never runs; the bindings read the node's value right after `onBeforeRender`.
 */
export function attachSurfaceDraw(object: Object3D): SurfaceDraw {
  const draw: SurfaceDraw = {
    texture: undefined,
    transform: new Vector4(1, 1, 0, 0),
    geographic: 1,
    fromTexture: undefined,
    fromTransform: new Vector4(1, 1, 0, 0),
    fromGeographic: 1,
    fade: 1,
  };
  object.userData['surfaceDraw'] = draw;
  object.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
    const node = material.userData['surfaceTexture'] as { value: Texture } | undefined;
    const fromNode = material.userData['fromTexture'] as { value: Texture } | undefined;
    if (node && draw.texture) node.value = draw.texture;
    if (fromNode && draw.fromTexture) fromNode.value = draw.fromTexture;
  };
  return draw;
}

/**
 * The surface material shared by every tile: one shader and one pipeline for the whole surface (ADR 0010 §4, §7).
 * The UV transform and the choice of v are object-scope uniforms read from each mesh's {@link SurfaceDraw}, and the
 * texture is set per mesh before it draws (see {@link attachSurfaceDraw}), so tiles drawing different imagery tiles
 * still share the material. `placeholder` only fixes the texture binding's type.
 */
export function createSurfaceMaterial(placeholder: Texture, depthPath: DepthPath): MeshBasicNodeMaterial {
  const tileUv = attribute('tileUv', 'vec3');
  const transform = uniform(new Vector4(1, 1, 0, 0)).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.transform);
  const geographic = uniform(1).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.geographic);
  const fromTransform = uniform(new Vector4(1, 1, 0, 0)).onObjectUpdate(
    ({ object }) => surfaceDrawOf(object)?.fromTransform,
  );
  const fromGeographic = uniform(1).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.fromGeographic);
  const fade = uniform(1).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.fade);
  const v = mix(tileUv.y, tileUv.z, geographic);
  const uv = vec2(tileUv.x.mul(transform.x).add(transform.z), v.mul(transform.y).add(transform.w));
  const fromV = mix(tileUv.y, tileUv.z, fromGeographic);
  const fromUv = vec2(
    tileUv.x.mul(fromTransform.x).add(fromTransform.z),
    fromV.mul(fromTransform.y).add(fromTransform.w),
  );
  const material = new MeshBasicNodeMaterial();
  const map = texture(placeholder, uv);
  // A texture object of its own, as bindings are shared between nodes made from the same texture: one texel, so the
  // binding costs no copy of the placeholder's image on the GPU. Every draw points it at a real texture.
  const fromPlaceholder = new DataTexture(new Uint8Array(4), 1, 1);
  // Same sampling as the placeholder: on WebGPU the sampler set up with the binding stays when the texture changes.
  fromPlaceholder.colorSpace = placeholder.colorSpace;
  fromPlaceholder.minFilter = placeholder.minFilter;
  fromPlaceholder.magFilter = placeholder.magFilter;
  fromPlaceholder.wrapS = placeholder.wrapS;
  fromPlaceholder.wrapT = placeholder.wrapT;
  fromPlaceholder.anisotropy = placeholder.anisotropy;
  fromPlaceholder.needsUpdate = true;
  const fromMap = texture(fromPlaceholder, fromUv);
  material.userData['surfaceTexture'] = map;
  material.userData['fromTexture'] = fromMap;
  // A cross-fade mixes the two imageries in one draw, never two overlapping draws (ADR 0006), and in a perceptual
  // space (gamma 2, close to sRGB): a linear-light mix would change dark pixels several times faster than bright ones.
  // Only fading draws sample the second texture (fade is uniform per draw, so the branch is too): on a software
  // rasterizer the extra fetch costs about half a frame.
  material.colorNode = Fn(() => {
    const color = map.toVar();
    If(fade.lessThan(1), () => {
      color.assign(mix(fromMap.sqrt(), color.sqrt(), fade).pow2());
    });
    return color;
  })();
  makeEyeRelative(material, depthPath);
  // Skirts face outward on some edges; drawing both sides keeps every crack filled.
  material.side = DoubleSide;
  return material;
}

/**
 * Points a mesh's draw state at draw `i` of a frame's list: its texture and the one it fades from, looked up in
 * `textures` by handle, with the world base image for the base handle (or a texture no longer held).
 */
export function applyDraw(
  draw: SurfaceDraw,
  draws: TileDrawList,
  i: number,
  textures: { get(handle: number): Texture | undefined },
  base: Texture,
): void {
  draw.texture = textures.get(draws.textures[i] ?? -1) ?? base;
  draw.geographic = draws.geographic[i] ?? 1;
  draw.fromTexture = textures.get(draws.fromTextures[i] ?? -1) ?? base;
  draw.fromGeographic = draws.fromGeographic[i] ?? 1;
  draw.fade = draws.fades[i] ?? 1;
  const at = i * 4;
  const u = draws.uvTransforms;
  draw.transform.set(u[at] ?? 1, u[at + 1] ?? 1, u[at + 2] ?? 0, u[at + 3] ?? 0);
  const f = draws.fromUvTransforms;
  draw.fromTransform.set(f[at] ?? 1, f[at + 1] ?? 1, f[at + 2] ?? 0, f[at + 3] ?? 0);
}
