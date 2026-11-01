// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { type DepthPath, type MorphFrame, type TileDrawList } from '@vibeglobe/core';
import { attribute, Fn, If, mix, positionGeometry, select, texture, uniform, vec3, vec4 } from 'three/tsl';
import {
  DataTexture,
  DoubleSide,
  Matrix3,
  Matrix4,
  MeshBasicNodeMaterial,
  Vector4,
  type Material,
  type Mesh,
  type Node,
  type Object3D,
  type Texture,
} from 'three/webgpu';
import { makeMorphedEyeRelative } from './eye-relative.js';
import { column, createFlatHeights, flag, mapUv, terrainHeight } from './surface-heights.js';
import type { ToneMatcher } from './tone-matching.js';
import type { Atmosphere } from './atmosphere/atmosphere.js';

/** What one surface tile draws this frame: set on its mesh before each frame, read by the shared material. */
export interface SurfaceDraw {
  /**
   * The textures the draw samples, set by every frame that draws the mesh, by index: the imagery, the imagery it
   * cross-fades from (F105), the terrain heights it shows and the ones it morphs from (ADR 0006 §4, F138), the coarser
   * terrain its stitched edges take their heights from (KB-178), the two overlay slots' imagery (ADR 0038; unset where
   * a slot is empty) and the imagery each slot cross-fades from (KB-155; unset where it fades in from nothing).
   */
  readonly textures: (Texture | undefined)[];
  /**
   * The four UV transforms (scale u, scale v, offset u, offset v), one per column: imagery, the imagery faded from,
   * terrain, the terrain morphed from. One matrix and one vector carry every per-draw number, as three.js rebuilds
   * every object uniform's update range each frame (F064).
   */
  readonly transforms: Matrix4;
  /**
   * x: bit flags, set when the rows of the imagery (1), the imagery faded from (2), the terrain (4) and the terrain
   * morphed from (8) are linear in latitude rather than the tile's own; y: the imagery fade (0 only the `from` imagery,
   * 1 only the tile's own); z: the terrain morph, likewise; w: meters to lower the skirts by beyond the mesh's own
   * depth (terrain coarser than the tile's level, `TileDrawList.terrain.skirtMeters`).
   */
  readonly params: Vector4;
  /**
   * The tone gains of the draw's imagery (column 0, rgb) and of the imagery it fades from (column 1), 1 without tone
   * matching (F249, ADR 0044). Packed here to add no uniform: column 2 (bits of the terrain edges that take the stitch
   * heights, north 1, east 2, south 4, west 8, `TileDrawLayer.stitchEdges`, KB-178; the levels a neighbor's mesh is
   * coarser by, three bits per edge in the same order, KB-302; the terrain height scales at
   * the north and south edges, `TileDrawLayer.heightScales`, KB-180), column 3 the UV transform into the stitch heights.
   */
  readonly tones: Matrix4;
  /**
   * The overlays' numbers, by column: the two UV transforms; (geographic 0, geographic 1, opacity 0, opacity 1);
   * (blend 0, blend 1, 0, 0), blends as `TileDrawOverlay.blends` (0 normal, 1 multiply, 2 screen).
   */
  readonly overlays: Matrix4;
  /**
   * The overlays' fades, by column: the two `from` UV transforms; (from geographic 0, from geographic 1, fade 0, fade
   * 1), the fades as the base imagery's (1 only the slot's own imagery); (from set 0, from set 1, 0, 0).
   */
  readonly overlayFades: Matrix4;
  /** The overlay slots' tone gains (F633), linear rgb: slot 0 in column 0, slot 1 in column 1. */
  readonly overlayTones: Matrix4;
}

/** The draw state of a surface mesh, created with the mesh. */
function surfaceDrawOf(object: Object3D | null): SurfaceDraw | undefined {
  return object?.userData['surfaceDraw'] as SurfaceDraw | undefined;
}

/**
 * Forgets every texture a surface mesh's draw state names (TG-01): after a device loss they belong to the lost
 * renderer, whose texture system listens to them, so a mesh not drawn again would keep that renderer alive.
 */
function clearSurfaceDraw(draw: SurfaceDraw): void {
  draw.textures.fill(undefined);
}

/** Frees a surface mesh's geometry and forgets its textures when its renderer is lost (TG-01). */
export function releaseForRecovery(entry: { readonly mesh: Mesh; readonly draw: SurfaceDraw }): void {
  entry.mesh.geometry.dispose();
  clearSurfaceDraw(entry.draw);
}

/** `SurfaceDraw.textures` indices: the first of the heights, the first after them, the overlays and their fades. */
const HEIGHTS = 2;
const STITCH_HEIGHTS = 4;
const OVERLAY = 5;
const OVERLAY_FROM = 7;

/** The texture nodes whose value each mesh sets before it draws, in `SurfaceDraw.textures` order. */
function perDrawNodes(material: Material): ({ value: Texture } | undefined)[] {
  return (material.userData['perDraw'] ??= []) as ({ value: Texture } | undefined)[];
}

/**
 * Attaches a draw state to a new surface mesh. Its textures reach the shared texture nodes just before the mesh is
 * drawn: three.js resets a texture node's update type when it builds the shader, so a per-object update on the node
 * itself never runs; the bindings read the node's value right after `onBeforeRender`.
 */
export function attachSurfaceDraw(object: Object3D): SurfaceDraw {
  const draw: SurfaceDraw = {
    textures: new Array<Texture | undefined>(OVERLAY_FROM + 2).fill(undefined),
    transforms: new Matrix4().set(1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0),
    params: new Vector4(15, 1, 1, 0),
    tones: new Matrix4().set(1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0),
    overlays: new Matrix4().set(1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    overlayFades: new Matrix4().set(1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0),
    overlayTones: new Matrix4().set(1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0),
  };
  object.userData['surfaceDraw'] = draw;
  // The textures are read from the draw state at each draw, never kept: a mesh not drawn after a device loss kept the
  // lost renderer alive through them (TG-01).
  object.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
    const nodes = perDrawNodes(material);
    const flat = material.userData['flatHeights'] as Texture | undefined;
    for (let i = 0; i < nodes.length; i++) {
      // Draws without terrain use the material's flat heights; empty overlay slots keep their texture (opacity 0).
      const value = draw.textures[i] ?? (i >= HEIGHTS && i <= STITCH_HEIGHTS ? flat : undefined);
      const node = nodes[i];
      if (node && value) node.value = value;
    }
  };
  return draw;
}

/** A texture object of its own for a second binding of the same kind, sampled like `like`. */
function placeholderLike(like: Texture): DataTexture {
  const placeholder = new DataTexture(new Uint8Array(4), 1, 1);
  // Same sampling as the placeholder: on WebGPU the sampler set up with the binding stays when the texture changes.
  placeholder.colorSpace = like.colorSpace;
  placeholder.minFilter = like.minFilter;
  placeholder.magFilter = like.magFilter;
  placeholder.wrapS = like.wrapS;
  placeholder.wrapT = like.wrapT;
  placeholder.anisotropy = like.anisotropy;
  placeholder.needsUpdate = true;
  return placeholder;
}

/**
 * Places the surface's vertices (ADR 0008): skirt vertices carry a normal of length 2 (the mesh marks them so) and hang
 * `params.w` lower still; heights are scaled by the relief factor on both endpoints; on the plane each vertex sits at
 * its Mercator offset from the tile's plane center times σ, raised σ·k(φ)·h along the anchor's up.
 */
function placeMorphed(
  material: MeshBasicNodeMaterial,
  depthPath: DepthPath,
  height: Node<'float'>,
  params: Node<'vec4'>,
  morphParams: Node<'vec4'>,
  morphAxes: Node<'mat3'>,
): { eyeRelative: Node<'vec3'>; reliefMeters: Node<'float'> } {
  const tileNormal = attribute('tileNormal', 'vec3');
  const tilePlane = attribute('tilePlane', 'vec4');
  const skirt = tileNormal.length().greaterThan(1.5);
  const skirtExtra = skirt.select(params.w, 0);
  const sigma = morphParams.z;
  const reliefHeight = height.mul(morphParams.y);
  const globeOffset = positionGeometry.add(tileNormal.normalize().mul(reliefHeight.sub(skirtExtra)));
  const planeLocal = vec3(
    tilePlane.x.mul(sigma),
    tilePlane.y.mul(sigma),
    reliefHeight.mul(tilePlane.w).mul(sigma).add(tilePlane.z).sub(skirtExtra),
  );
  const eyeRelative = makeMorphedEyeRelative(
    material,
    depthPath,
    globeOffset,
    morphAxes.mul(planeLocal),
    morphParams.x,
  );
  return { eyeRelative, reliefMeters: reliefHeight };
}

/**
 * The overlay slots of the surface material (ADR 0038): two textures with their UV transforms, opacities and blend
 * modes from each mesh's {@link SurfaceDraw}. Returns what composes them over a color, in the slots' order, and returns
 * the light of the night slots (blend 3, F647), which the atmosphere adds where it is night; a slot of opacity 0
 * samples nothing (the opacity is uniform per draw, so the branch is too). Their placeholder textures are disposed
 * with the material.
 */
function overlaySlots(
  material: MeshBasicNodeMaterial,
  placeholder: Texture,
  tileUv: Node<'vec3'>,
): (color: Node<'vec4'>) => Node<'vec3'> {
  const overlays = uniform(new Matrix4()).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.overlays);
  const fades = uniform(new Matrix4()).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.overlayFades);
  const looks = column(overlays, 2);
  const blends = column(overlays, 3);
  const fadeLooks = column(fades, 2);
  const fromSet = column(fades, 3);
  const tones = uniform(new Matrix4()).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.overlayTones);
  // The slots' tone gains (F633).
  const gains = [column(tones, 0).xyz, column(tones, 1).xyz];
  const slots = [0, 1].map((slot) => {
    const own = placeholderLike(placeholder);
    const fromOwn = placeholderLike(placeholder);
    material.addEventListener('dispose', () => {
      own.dispose();
      fromOwn.dispose();
    });
    const node = texture(own, mapUv(tileUv, column(overlays, slot), slot === 0 ? looks.x : looks.y));
    const fromNode = texture(fromOwn, mapUv(tileUv, column(fades, slot), slot === 0 ? fadeLooks.x : fadeLooks.y));
    perDrawNodes(material)[OVERLAY + slot] = node;
    perDrawNodes(material)[OVERLAY_FROM + slot] = fromNode;
    return {
      node,
      fromNode,
      hasFrom: slot === 0 ? fromSet.x : fromSet.y,
      fade: slot === 0 ? fadeLooks.z : fadeLooks.w,
      opacity: slot === 0 ? looks.z : looks.w,
      blend: slot === 0 ? blends.x : blends.y,
      gain: gains[slot] ?? vec3(1),
    };
  });
  return (color) => {
    const night = vec3(0).toVar();
    for (const { node: own, fromNode, hasFrom, fade, opacity, blend, gain } of slots) {
      If(opacity.greaterThan(0), () => {
        // The slot's imagery cross-fades from what it showed, or fades in from nothing (KB-155); like the base
        // imagery's, only fading draws sample the second texture.
        const node = own.toVar();
        If(fade.lessThan(1), () => {
          const from = vec4(0).toVar();
          If(hasFrom.greaterThan(0.5), () => {
            from.assign(fromNode);
          });
          node.assign(mix(from, node, fade));
        });
        // A variable, as both branches read it: a node is emitted where it is first used (KB-141).
        const over = node.xyz.mul(gain).toVar();
        If(blend.greaterThan(2.5), () => {
          night.addAssign(over.mul(node.w.mul(opacity)));
        }).Else(() => {
          const multiplied = color.xyz.mul(over);
          const screened = vec3(1).sub(vec3(1).sub(color.xyz).mul(vec3(1).sub(over)));
          const blended = select(blend.lessThan(0.5), over, select(blend.lessThan(1.5), multiplied, screened));
          color.assign(vec4(mix(color.xyz, blended, node.w.mul(opacity)), color.w));
        });
      });
    }
    return night;
  };
}

/**
 * The surface material shared by every tile: one shader and one pipeline for the whole surface (ADR 0010 §4, §7).
 * The UV transforms and flags are object-scope uniforms read from each mesh's {@link SurfaceDraw}, and the textures
 * are set per mesh before it draws (see {@link attachSurfaceDraw}), so tiles drawing different data tiles still share
 * the material. `placeholder` only fixes the texture binding's type. The material owns the flat heights of draws
 * without terrain and disposes them with itself. With an `atmosphere`, haze and sun lighting shade its color.
 */
export function createSurfaceMaterial(
  placeholder: Texture,
  depthPath: DepthPath,
  atmosphere?: Atmosphere,
): MeshBasicNodeMaterial {
  const tileUv = attribute('tileUv', 'vec3');
  // Per frame (ADR 0008): the morph factor, the relief factor and σ; the anchor's east, north and up axes in ECEF.
  const morphParams = uniform(new Vector4(0, 1, 1, 0));
  const morphAxes = uniform(new Matrix3());
  const transforms = uniform(new Matrix4()).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.transforms);
  const params = uniform(new Vector4(15, 1, 1, 0)).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.params);
  const fade = params.y;
  const uv = mapUv(tileUv, column(transforms, 0), flag(params.x, 1));
  const fromUv = mapUv(tileUv, column(transforms, 1), flag(params.x, 2));
  const material = new MeshBasicNodeMaterial();
  const tones = uniform(new Matrix4()).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.tones);
  const map = texture(placeholder, uv);
  // Textures of their own, as bindings are shared between nodes made from the same texture; tiny, so the bindings
  // cost no copy on the GPU. Every draw points them at real textures.
  const fromPlaceholder = placeholderLike(placeholder);
  const flatHeights = createFlatHeights();
  const fromFlat = createFlatHeights();
  const stitchFlat = createFlatHeights();
  const fromMap = texture(fromPlaceholder, fromUv);
  const heights = texture(flatHeights);
  const fromHeights = texture(fromFlat);
  const stitchHeights = texture(stitchFlat);
  // Disposed with the material: an undisposed texture keeps its renderer reachable through its dispose listener.
  const disposeOwn = (): void => {
    material.removeEventListener('dispose', disposeOwn);
    fromPlaceholder.dispose();
    flatHeights.dispose();
    fromFlat.dispose();
    stitchFlat.dispose();
  };
  material.addEventListener('dispose', disposeOwn);
  perDrawNodes(material).splice(0, STITCH_HEIGHTS + 1, map, fromMap, heights, fromHeights, stitchHeights);
  material.userData['flatHeights'] = flatHeights;
  material.userData['morphParams'] = morphParams;
  material.userData['morphAxes'] = morphAxes;
  const height = terrainHeight(tileUv, { heights, fromHeights, stitchHeights }, transforms, params, tones);
  // A cross-fade mixes the two imageries in one draw, never two overlapping draws (ADR 0006), and in a perceptual
  // space (gamma 2, close to sRGB): a linear-light mix would change dark pixels several times faster than bright ones.
  // Only fading draws sample the second texture (fade is uniform per draw, so the branch is too): on a software
  // rasterizer the extra fetch costs about half a frame.
  const composeOverlays = overlaySlots(material, placeholder, tileUv);
  const { eyeRelative, reliefMeters } = placeMorphed(material, depthPath, height, params, morphParams, morphAxes);
  material.colorNode = Fn(() => {
    // Each imagery with its source's tone gain (F249): 1 unless the layer matches its chain's tones.
    const color = map.mul(vec4(column(tones, 0).xyz, 1)).toVar();
    If(fade.lessThan(1), () => {
      color.assign(mix(fromMap.mul(vec4(column(tones, 1).xyz, 1)).sqrt(), color.sqrt(), fade).pow2());
    });
    const night = composeOverlays(color);
    if (!atmosphere) return color;
    // Haze, sun lighting, day and night (F394, F396, F647), slopes shaded by the relief drawn: the uniforms live in
    // the atmosphere, so a new one needs a new material.
    return vec4(atmosphere.surfaceColor(color.xyz, eyeRelative, reliefMeters, night), color.w);
  })();
  // Skirts face outward on some edges; drawing both sides keeps every crack filled.
  material.side = DoubleSide;
  return material;
}

const NO_HEIGHTS = -1;

/** The imagery handles of the polar caps' fills in core's draw list (KB-211). */
const NORTH_CAP_TEXTURE = -2;
const SOUTH_CAP_TEXTURE = -3;

/** The imagery texture of a handle: a tile's, a polar cap's fill (KB-211), else the base image. */
function imageryOf(
  textures: { get(handle: number): Texture | undefined },
  base: Texture,
  caps: readonly Texture[] | undefined,
  handle: number,
): Texture {
  if (handle === NORTH_CAP_TEXTURE) return caps?.[0] ?? base;
  if (handle === SOUTH_CAP_TEXTURE) return caps?.[1] ?? base;
  return textures.get(handle) ?? base;
}

/**
 * Points a mesh's draw state at draw `i` of a frame's list: its textures and the ones it fades from, looked up in
 * `textures` by handle, with the polar caps' fills (`textures.caps`, north then south) for their handles and the world base
 * image for the base handle (or a texture no longer held); without terrain the heights stay unset and the material's
 * flat heights apply.
 */
export function applyDraw(
  draw: SurfaceDraw,
  draws: TileDrawList,
  i: number,
  textures: {
    get(handle: number): Texture | undefined;
    readonly tones?: ToneMatcher;
    readonly caps?: { readonly textures: readonly Texture[] };
  },
  base: Texture,
): void {
  textures.tones?.apply(draws, i, draw.tones.elements);
  const terrain = draws.terrain;
  const caps = textures.caps?.textures;
  const own = draw.textures;
  own[0] = imageryOf(textures, base, caps, draws.textures[i] ?? -1);
  own[1] = imageryOf(textures, base, caps, draws.fromTextures[i] ?? -1);
  own[HEIGHTS] = textures.get(terrain.textures[i] ?? NO_HEIGHTS);
  own[HEIGHTS + 1] = textures.get(terrain.fromTextures[i] ?? NO_HEIGHTS);
  const flags =
    (draws.geographic[i] ?? 1) +
    2 * (draws.fromGeographic[i] ?? 1) +
    4 * (terrain.geographic[i] ?? 1) +
    8 * (terrain.fromGeographic[i] ?? 1);
  draw.params.set(flags, draws.fades[i] ?? 1, terrain.fades[i] ?? 1, terrain.skirtMeters[i] ?? 0);
  const t = draw.tones.elements;
  const at = i * 4;
  const stitch = (own[STITCH_HEIGHTS] = textures.get(terrain.stitchTextures?.[i] ?? NO_HEIGHTS));
  let edges = 0;
  let steps = 0;
  for (let c = 0; c < 4; c++) {
    const e = terrain.stitchEdges?.[at + c] ?? 0;
    if (stitch && e & 1) edges += 2 ** c;
    steps += (e >> 5) * 8 ** c;
    t[12 + c] = terrain.stitchTransforms?.[at + c] ?? 0;
  }
  t[8] = edges;
  t[9] = steps;
  t[10] = terrain.heightScales?.[i * 2] ?? 1;
  t[11] = terrain.heightScales?.[i * 2 + 1] ?? 1;
  const e = draw.transforms.elements;
  for (let c = 0; c < 4; c++) {
    e[c] = draws.uvTransforms[at + c] ?? 0;
    e[4 + c] = draws.fromUvTransforms[at + c] ?? 0;
    e[8 + c] = terrain.uvTransforms[at + c] ?? 0;
    e[12 + c] = terrain.fromUvTransforms[at + c] ?? 0;
  }
  applyOverlays(draw, draws, i, textures);
}

/** Points a mesh's overlay slots at draw `i`'s overlays; a slot whose texture is no longer held shows nothing. */
function applyOverlays(
  draw: SurfaceDraw,
  draws: TileDrawList,
  i: number,
  textures: { get(handle: number): Texture | undefined; readonly tones?: ToneMatcher },
): void {
  const o = draw.overlays.elements;
  const f = draw.overlayFades.elements;
  for (let slot = 0; slot < 2; slot++) {
    const overlay = draws.overlays[slot];
    const shown = overlay && (overlay.opacities[i] ?? 0) > 0 ? textures.get(overlay.textures[i] ?? -1) : undefined;
    draw.textures[OVERLAY + slot] = shown;
    o[8 + slot] = overlay?.geographic[i] ?? 0;
    o[10 + slot] = shown && overlay ? (overlay.opacities[i] ?? 0) : 0;
    o[12 + slot] = overlay?.blends[i] ?? 0;
    for (let c = 0; c < 4; c++) o[slot * 4 + c] = overlay?.uvTransforms[i * 4 + c] ?? 0;
    // The cross-fade (KB-155): from the imagery the slot showed, or from nothing when it had none.
    const fade = overlay?.fades[i] ?? 1;
    const from = shown && overlay && fade < 1 ? textures.get(overlay.fromTextures[i] ?? -1) : undefined;
    draw.textures[OVERLAY_FROM + slot] = from;
    f[8 + slot] = overlay?.fromGeographic[i] ?? 0;
    f[10 + slot] = shown ? fade : 1;
    f[12 + slot] = from ? 1 : 0;
    for (let c = 0; c < 4; c++) f[slot * 4 + c] = overlay?.fromUvTransforms[i * 4 + c] ?? 0;
  }
  // The slots' tone gains (F633), 1 where a slot matches nothing (written one by one: the frame loop allocates nothing).
  const gains = draw.overlayTones.elements;
  for (let slot = 0; slot < 2; slot++) {
    const overlay = draws.overlays[slot];
    if (overlay && (overlay.toneSources?.[i] ?? -1) >= 0) textures.tones?.applyOverlay(overlay, i, gains, slot * 4);
    else for (let c = 0; c < 3; c++) gains[slot * 4 + c] = 1;
  }
}

/**
 * Sets the morph uniforms of a surface material for a frame (ADR 0008): the morph and relief factors, σ and the
 * anchor's axes (column-major east, north, up, as `MorphFrame.axes`).
 */
export function setSurfaceMorph(material: Material, morph: MorphFrame): void {
  const params = material.userData['morphParams'] as { value: Vector4 } | undefined;
  const axes = material.userData['morphAxes'] as { value: Matrix3 } | undefined;
  // From the factors array, not the getters: a double returned by a call that is not inlined is boxed (F064).
  const factors = morph.factors;
  params?.value.set(factors[0] ?? 0, factors[1] ?? 1, factors[2] ?? 1, 0);
  axes?.value.fromArray(morph.axes);
}
