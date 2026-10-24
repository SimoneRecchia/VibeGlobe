import type { DepthPath, MorphFrame, TileDrawList } from '@vibeglobe/core';
import {
  attribute,
  clamp,
  float,
  floor,
  Fn,
  If,
  int,
  ivec2,
  min,
  mix,
  positionGeometry,
  select,
  texture,
  textureLoad,
  textureSize,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  DataTexture,
  DoubleSide,
  FloatType,
  Matrix3,
  Matrix4,
  MeshBasicNodeMaterial,
  NearestFilter,
  RedFormat,
  Vector4,
  type Material,
  type Node,
  type Object3D,
  type Texture,
  type TextureNode,
} from 'three/webgpu';
import { makeMorphedEyeRelative } from './eye-relative.js';
import type { Atmosphere } from './atmosphere/atmosphere.js';

/** What one surface tile draws this frame: set on its mesh before each frame, read by the shared material. */
export interface SurfaceDraw {
  /** Set by every frame that draws the mesh, before it draws. */
  texture: Texture | undefined;
  /** The imagery the tile cross-fades from (F105). */
  fromTexture: Texture | undefined;
  /** The terrain heights the tile shows and the ones it morphs from (ADR 0006 §4, F138). */
  heights: Texture | undefined;
  fromHeights: Texture | undefined;
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
  /** The imagery of the two overlay slots (ADR 0038), drawn above the tile's own; unset where a slot is empty. */
  overlay0: Texture | undefined;
  overlay1: Texture | undefined;
  /**
   * The overlays' numbers, by column: the two UV transforms; (geographic 0, geographic 1, opacity 0, opacity 1);
   * (blend 0, blend 1, 0, 0), blends as `TileDrawOverlay.blends` (0 normal, 1 multiply, 2 screen).
   */
  readonly overlays: Matrix4;
}

/** The draw state of a surface mesh, created with the mesh. */
function surfaceDrawOf(object: Object3D | null): SurfaceDraw | undefined {
  return object?.userData['surfaceDraw'] as SurfaceDraw | undefined;
}

/** Texture nodes whose value each mesh sets before it draws, by key in the material's `userData`. */
const PER_DRAW_TEXTURES = ['surfaceTexture', 'fromTexture', 'heights', 'fromHeights', 'overlay0', 'overlay1'] as const;

/**
 * Attaches a draw state to a new surface mesh. Its textures reach the shared texture nodes just before the mesh is
 * drawn: three.js resets a texture node's update type when it builds the shader, so a per-object update on the node
 * itself never runs; the bindings read the node's value right after `onBeforeRender`.
 */
export function attachSurfaceDraw(object: Object3D): SurfaceDraw {
  const draw: SurfaceDraw = {
    texture: undefined,
    fromTexture: undefined,
    heights: undefined,
    fromHeights: undefined,
    transforms: new Matrix4().set(1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0),
    params: new Vector4(15, 1, 1, 0),
    overlay0: undefined,
    overlay1: undefined,
    overlays: new Matrix4().set(1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  };
  object.userData['surfaceDraw'] = draw;
  const values = [draw.texture, draw.fromTexture, draw.heights, draw.fromHeights, draw.overlay0, draw.overlay1];
  object.onBeforeRender = (_renderer, _scene, _camera, _geometry, material) => {
    values[0] = draw.texture;
    values[1] = draw.fromTexture;
    values[2] = draw.heights;
    values[3] = draw.fromHeights;
    values[4] = draw.overlay0;
    values[5] = draw.overlay1;
    for (let i = 0; i < PER_DRAW_TEXTURES.length; i++) {
      const node = material.userData[PER_DRAW_TEXTURES[i] ?? ''] as { value: Texture } | undefined;
      // Draws without terrain use the material's flat heights; empty overlay slots keep their texture (opacity 0).
      const value =
        values[i] ?? (i === 2 || i === 3 ? (material.userData['flatHeights'] as Texture | undefined) : undefined);
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
 * The height grid of a surface without terrain: 2 × 2 vertices at height 0 (one cell, so the sampling below needs no
 * special case). Float32 with nearest filtering, like every height texture (`tile-textures.ts`).
 */
function createFlatHeights(): DataTexture {
  const texture = new DataTexture(new Float32Array(4), 2, 2, RedFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Bit `bit` (a power of two) of a float holding small integer flags, as 0 or 1. */
function flag(flags: Node<'float'>, bit: number): Node<'float'> {
  return floor(flags.div(bit)).mod(2);
}

/**
 * The height at `uv` of a grid texture of (cells + 1)² vertices (`terrain/sample-height.ts`, ADR 0006 §5): piecewise
 * linear over cells split along the north-west to south-east diagonal, read with `textureLoad` (no filtering of
 * float textures needed), positions clamped to the tile.
 */
function sampleHeight(heights: TextureNode, uv: Node<'vec2'>): Node<'float'> {
  // textureSize is typed without its components.
  const size = textureSize(heights, int(0)) as unknown as Node<'ivec2'>;
  const cells = float(size.x).sub(1);
  const x = clamp(uv.x, 0, 1).mul(cells);
  const y = clamp(uv.y, 0, 1).mul(cells);
  const col = min(floor(x), cells.sub(1));
  const row = min(floor(y), cells.sub(1));
  const fx = x.sub(col);
  const fy = y.sub(row);
  const at = (dx: number, dy: number): Node<'float'> =>
    textureLoad(heights, ivec2(int(col.add(dx)), int(row.add(dy)))).x;
  const nw = at(0, 0);
  const ne = at(1, 0);
  const sw = at(0, 1);
  const se = at(1, 1);
  const upper = nw.add(ne.sub(nw).mul(fx)).add(se.sub(ne).mul(fy));
  const lower = nw.add(se.sub(sw).mul(fx)).add(sw.sub(nw).mul(fy));
  return select(fx.greaterThanEqual(fy), upper, lower);
}

/** Column `index` of a matrix uniform (the matrix times a unit vector). */
function column(matrix: Node<'mat4'>, index: number): Node<'vec4'> {
  return matrix.mul(vec4(index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0, index === 3 ? 1 : 0));
}

/** Tile coordinates through one transform column, with v linear in latitude when `geographic` is 1. */
function mapUv(tileUv: Node<'vec3'>, transform: Node<'vec4'>, geographic: Node<'float'>): Node<'vec2'> {
  const v = mix(tileUv.y, tileUv.z, geographic);
  return vec2(tileUv.x.mul(transform.x).add(transform.z), v.mul(transform.y).add(transform.w));
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
 * modes from each mesh's {@link SurfaceDraw}. Returns what composes them over a color, in the slots' order; a slot of
 * opacity 0 samples nothing (the opacity is uniform per draw, so the branch is too). Their placeholder textures are
 * disposed with the material.
 */
function overlaySlots(
  material: MeshBasicNodeMaterial,
  placeholder: Texture,
  tileUv: Node<'vec3'>,
): (color: Node<'vec4'>) => void {
  const overlays = uniform(new Matrix4()).onObjectUpdate(({ object }) => surfaceDrawOf(object)?.overlays);
  const looks = column(overlays, 2);
  const blends = column(overlays, 3);
  const slots = [0, 1].map((slot) => {
    const own = placeholderLike(placeholder);
    material.addEventListener('dispose', () => own.dispose());
    const node = texture(own, mapUv(tileUv, column(overlays, slot), slot === 0 ? looks.x : looks.y));
    material.userData[`overlay${String(slot)}`] = node;
    return { node, opacity: slot === 0 ? looks.z : looks.w, blend: slot === 0 ? blends.x : blends.y };
  });
  return (color) => {
    for (const { node, opacity, blend } of slots) {
      If(opacity.greaterThan(0), () => {
        const over = node.xyz;
        const multiplied = color.xyz.mul(over);
        const screened = vec3(1).sub(vec3(1).sub(color.xyz).mul(vec3(1).sub(over)));
        const blended = select(blend.lessThan(0.5), over, select(blend.lessThan(1.5), multiplied, screened));
        color.assign(vec4(mix(color.xyz, blended, node.w.mul(opacity)), color.w));
      });
    }
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
  const morph = params.z;
  const uv = mapUv(tileUv, column(transforms, 0), flag(params.x, 1));
  const fromUv = mapUv(tileUv, column(transforms, 1), flag(params.x, 2));
  const material = new MeshBasicNodeMaterial();
  const map = texture(placeholder, uv);
  // Textures of their own, as bindings are shared between nodes made from the same texture; tiny, so the bindings
  // cost no copy on the GPU. Every draw points them at real textures.
  const fromPlaceholder = placeholderLike(placeholder);
  const flatHeights = createFlatHeights();
  const fromFlat = createFlatHeights();
  const fromMap = texture(fromPlaceholder, fromUv);
  const heights = texture(flatHeights);
  const fromHeights = texture(fromFlat);
  // Disposed with the material: an undisposed texture keeps its renderer reachable through its dispose listener.
  const disposeOwn = (): void => {
    material.removeEventListener('dispose', disposeOwn);
    fromPlaceholder.dispose();
    flatHeights.dispose();
    fromFlat.dispose();
  };
  material.addEventListener('dispose', disposeOwn);
  material.userData['surfaceTexture'] = map;
  material.userData['fromTexture'] = fromMap;
  material.userData['heights'] = heights;
  material.userData['fromHeights'] = fromHeights;
  material.userData['flatHeights'] = flatHeights;
  material.userData['morphParams'] = morphParams;
  material.userData['morphAxes'] = morphAxes;
  // Terrain: displaced along the ellipsoid normal by mix(H_from, H_to, morph) (ADR 0006 §4, §5); the morph samples
  // the second grid only while it runs.
  const height = Fn(() => {
    const h = sampleHeight(heights, mapUv(tileUv, column(transforms, 2), flag(params.x, 4))).toVar();
    If(morph.lessThan(1), () => {
      const from = sampleHeight(fromHeights, mapUv(tileUv, column(transforms, 3), flag(params.x, 8)));
      h.assign(mix(from, h, morph));
    });
    return h;
  })();
  // A cross-fade mixes the two imageries in one draw, never two overlapping draws (ADR 0006), and in a perceptual
  // space (gamma 2, close to sRGB): a linear-light mix would change dark pixels several times faster than bright ones.
  // Only fading draws sample the second texture (fade is uniform per draw, so the branch is too): on a software
  // rasterizer the extra fetch costs about half a frame.
  const composeOverlays = overlaySlots(material, placeholder, tileUv);
  material.colorNode = Fn(() => {
    const color = map.toVar();
    If(fade.lessThan(1), () => {
      color.assign(mix(fromMap.sqrt(), color.sqrt(), fade).pow2());
    });
    composeOverlays(color);
    return color;
  })();
  const { eyeRelative, reliefMeters } = placeMorphed(material, depthPath, height, params, morphParams, morphAxes);
  // Haze and sun lighting (F394, F396), slopes shaded by the relief drawn: the uniforms live in the atmosphere, so a
  // new one needs a new material.
  atmosphere?.applyToSurface(material, eyeRelative, reliefMeters);
  // Skirts face outward on some edges; drawing both sides keeps every crack filled.
  material.side = DoubleSide;
  return material;
}

const NO_HEIGHTS = -1;

/**
 * Points a mesh's draw state at draw `i` of a frame's list: its textures and the ones it fades from, looked up in
 * `textures` by handle, with the world base image for the base handle (or a texture no longer held); without
 * terrain the heights stay unset and the material's flat heights apply.
 */
export function applyDraw(
  draw: SurfaceDraw,
  draws: TileDrawList,
  i: number,
  textures: { get(handle: number): Texture | undefined },
  base: Texture,
): void {
  const terrain = draws.terrain;
  draw.texture = textures.get(draws.textures[i] ?? -1) ?? base;
  draw.fromTexture = textures.get(draws.fromTextures[i] ?? -1) ?? base;
  draw.heights = textures.get(terrain.textures[i] ?? NO_HEIGHTS);
  draw.fromHeights = textures.get(terrain.fromTextures[i] ?? NO_HEIGHTS);
  const flags =
    (draws.geographic[i] ?? 1) +
    2 * (draws.fromGeographic[i] ?? 1) +
    4 * (terrain.geographic[i] ?? 1) +
    8 * (terrain.fromGeographic[i] ?? 1);
  draw.params.set(flags, draws.fades[i] ?? 1, terrain.fades[i] ?? 1, terrain.skirtMeters[i] ?? 0);
  const e = draw.transforms.elements;
  const at = i * 4;
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
  textures: { get(handle: number): Texture | undefined },
): void {
  const o = draw.overlays.elements;
  for (let slot = 0; slot < 2; slot++) {
    const overlay = draws.overlays[slot];
    const shown = overlay && (overlay.opacities[i] ?? 0) > 0 ? textures.get(overlay.textures[i] ?? -1) : undefined;
    if (slot === 0) draw.overlay0 = shown;
    else draw.overlay1 = shown;
    o[8 + slot] = overlay?.geographic[i] ?? 0;
    o[10 + slot] = shown && overlay ? (overlay.opacities[i] ?? 0) : 0;
    o[12 + slot] = overlay?.blends[i] ?? 0;
    for (let c = 0; c < 4; c++) o[slot * 4 + c] = overlay?.uvTransforms[i * 4 + c] ?? 0;
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
