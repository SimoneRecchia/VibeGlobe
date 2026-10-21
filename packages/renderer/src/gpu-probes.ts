import type { DepthPath } from '@vibeglobe/core';
import { attribute, cameraProjectionMatrix, positionGeometry, screenUV, texture, varying, vec4 } from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  DepthTexture,
  DoubleSide,
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  RenderTarget,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import { depthPathOf } from './depth.js';
import { EngineCamera } from './engine-camera.js';
import { eyeRelativePosition, eyeRelativeViewPosition, makeEyeRelative, placeEyeRelative } from './eye-relative.js';
import {
  cameraFrame,
  depthDistances,
  exactClip,
  lowPartCase,
  PROBE_NEAR_METERS,
  PROBE_SCREEN,
  precisionCases,
  projectionMatrix,
  random,
  screenDistancePx,
  viewMatrix,
  type CameraFrame,
  type PrecisionCase,
} from './gpu-probe-cases.js';
import type { DepthChoice } from './three-backend.js';
import { patchIdentitySwizzle } from './webgpu-compat.js';

/** Which renderer the probes run on. */
export interface GpuProbeOptions {
  readonly backend: 'webgpu' | 'webgl2';
  /** 'fragment' forces WebGL2's fragment-written depth path (ADR 0005 §4). */
  readonly depth?: DepthChoice;
}

/** What the GPU produced against float64 (ADR 0004 and 0005 verification). */
export interface GpuProbeResult {
  readonly backend: 'webgpu' | 'webgl2';
  readonly depthPath: DepthPath;
  /** Tracked vertices: their clip positions read back from an rgba32float target, compared on a 4K screen. */
  readonly precision: {
    readonly cases: number;
    /** Cases whose pixel came back empty (0 when every vertex was drawn). */
    readonly missing: number;
    readonly maxErrorPx: number;
    /** The same vertices with T_lo zeroed: what a compiler that loses it would show. */
    readonly maxErrorWithoutLowPx: number;
    /** The fixed case of KB-025 with T_lo zeroed: proves the probe sees a lost T_lo (above 0.1 px). */
    readonly lowPartCaseWithoutLowPx: number;
  };
  /** (0.5 + 2^24) − 2^24 evaluated as the vertex node does: 0 in float32 order, 0.5 if the compiler reassociated. */
  readonly reassociation: { readonly value: number; readonly inOrder: boolean };
  /** Planes at known view distances, depth read back and reconstructed as d = near / z. */
  readonly depth: { readonly planes: number; readonly missing: number; readonly maxRelativeError: number };
}

const PRECISION_SIZE = 16;
const DEPTH_SIZE = 32;
const DEPTH_GRID = 8;

/**
 * The probes themselves, loaded by {@link runGpuProbes} (`run-gpu-probes.ts`): the engine's vertex node, offsets and
 * camera on a renderer set up like the engine's.
 */
export async function runGpuProbesNow(options: GpuProbeOptions): Promise<GpuProbeResult> {
  if (options.backend === 'webgpu') patchIdentitySwizzle(globalThis);
  const canvas = document.createElement('canvas');
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    reversedDepthBuffer: options.backend === 'webgpu' || options.depth !== 'fragment',
    forceWebGL: options.backend === 'webgl2',
  });
  await renderer.init();
  try {
    const depthPath = depthPathOf(renderer);
    if (depthPath === 'fragment') renderer.setClearDepth(0);
    const webgl = (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true;
    return {
      backend: webgl ? 'webgl2' : 'webgpu',
      depthPath,
      precision: await precisionProbe(renderer, depthPath),
      reassociation: await reassociationCanary(renderer),
      depth: await depthProbe(renderer, depthPath),
    };
  } finally {
    renderer.dispose();
  }
}

/** A scene and camera whose matrices only the probe writes. */
function probeStage(): { scene: Scene; camera: EngineCamera } {
  const scene = new Scene();
  scene.matrixWorldAutoUpdate = false;
  const camera = new EngineCamera();
  camera.matrixAutoUpdate = false;
  camera.matrixWorldAutoUpdate = false;
  return { scene, camera };
}

function addMesh(scene: Scene, geometry: BufferGeometry, material: MeshBasicNodeMaterial): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.matrixWorldAutoUpdate = false;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

function floatTarget(size: number, depth: boolean): RenderTarget {
  const target = new RenderTarget(size, size, {
    type: FloatType,
    depthBuffer: depth,
    magFilter: NearestFilter,
    minFilter: NearestFilter,
  });
  if (depth) target.depthTexture = new DepthTexture(size, size, FloatType);
  return target;
}

async function drawAndRead(renderer: WebGPURenderer, target: RenderTarget, stage: ReturnType<typeof probeStage>) {
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.render(stage.scene, stage.camera);
  renderer.setRenderTarget(null);
  const size = target.width;
  return (await renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size)) as Float32Array;
}

/** Two triangles covering the NDC rectangle [x0, x1] × [y0, y1], as positions (z = 0). */
function rectangle(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0];
}

/**
 * Each tracked vertex writes its clip position, with z replaced by its case number, to its own pixel; flat
 * interpolation passes it on unchanged.
 */
function trackingMaterial(): MeshBasicNodeMaterial {
  const clip = cameraProjectionMatrix.mul(eyeRelativeViewPosition(attribute('tracked', 'vec3')));
  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(positionGeometry.xy, 0, 1);
  material.fragmentNode = varying(vec4(clip.x, clip.y, attribute('caseIndex', 'float'), clip.w)).setInterpolation(
    'flat',
  );
  material.depthTest = false;
  material.depthWrite = false;
  return material;
}

/** Each case's error on the probe screen from the read-back pixels, in pixels; NaN for a case no pixel shows. */
function caseErrors(
  pixels: Float32Array,
  cases: readonly PrecisionCase[],
  view: Float64Array,
  projection: Float64Array,
): number[] {
  const worst = new Array<number>(cases.length).fill(Number.NaN);
  for (let p = 0; p < pixels.length; p += 4) {
    const w = pixels[p + 3] ?? 0;
    const index = Math.round(pixels[p + 2] ?? -1);
    const c = cases[index];
    if (!(w > 0) || !c) continue;
    const error = screenDistancePx([pixels[p] ?? 0, pixels[p + 1] ?? 0, w], exactClip(view, projection, c));
    const previous = worst[index] ?? Number.NaN;
    worst[index] = Number.isNaN(previous) ? error : Math.max(previous, error);
  }
  return worst;
}

async function precisionProbe(renderer: WebGPURenderer, depthPath: DepthPath): Promise<GpuProbeResult['precision']> {
  const fixed = lowPartCase();
  const toVertex = fixed.origin.map((o, i) => o + (fixed.offset[i] ?? 0) - (fixed.eye[i] ?? 0));
  const length = Math.hypot(toVertex[0] ?? 0, toVertex[1] ?? 0, toVertex[2] ?? 0);
  const frame = cameraFrame(
    toVertex.map((c) => c / length),
    random(7),
  );
  const cases = [fixed, ...precisionCases(frame, PRECISION_SIZE * PRECISION_SIZE - 1, random(1))];
  const view = viewMatrix(frame);
  const projection = projectionMatrix();
  const stage = probeStage();
  stage.camera.apply({ view, projection }, depthPath);
  const material = trackingMaterial();
  const pixel = 2 / PRECISION_SIZE;
  const meshes = cases.map((c, index) => {
    const geometry = new BufferGeometry();
    const x = -1 + (index % PRECISION_SIZE) * pixel;
    const y = -1 + Math.floor(index / PRECISION_SIZE) * pixel;
    geometry.setAttribute('position', new BufferAttribute(Float32Array.from(rectangle(x, y, x + pixel, y + pixel)), 3));
    geometry.setAttribute(
      'tracked',
      new BufferAttribute(
        Float32Array.from({ length: 18 }, (_, i) => c.offset[i % 3] ?? 0),
        3,
      ),
    );
    geometry.setAttribute('caseIndex', new BufferAttribute(new Float32Array(6).fill(index), 1));
    const mesh = addMesh(stage.scene, geometry, material);
    placeEyeRelative(mesh, c.origin, c.eye);
    return mesh;
  });
  const target = floatTarget(PRECISION_SIZE, false);
  const errors = (pixels: Float32Array): number[] => caseErrors(pixels, cases, view, projection);
  try {
    const withLow = errors(await drawAndRead(renderer, target, stage));
    for (const mesh of meshes) for (const i of [3, 7, 11]) mesh.matrixWorld.elements[i] = 0;
    const withoutLow = errors(await drawAndRead(renderer, target, stage));
    const seen = withLow.filter((error) => !Number.isNaN(error));
    return {
      cases: cases.length,
      missing: cases.length - seen.length,
      maxErrorPx: Math.max(...seen),
      maxErrorWithoutLowPx: Math.max(...withoutLow.filter((error) => !Number.isNaN(error))),
      lowPartCaseWithoutLowPx: withoutLow[0] ?? Number.NaN,
    };
  } finally {
    target.dispose();
    material.dispose();
    for (const mesh of meshes) mesh.geometry.dispose();
  }
}

async function reassociationCanary(renderer: WebGPURenderer): Promise<GpuProbeResult['reassociation']> {
  const stage = probeStage();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(rectangle(-1, -1, 1, 1)), 3));
  geometry.setAttribute('tracked', new BufferAttribute(new Float32Array(18).fill(0.5), 3));
  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(positionGeometry.xy, 0, 1);
  material.fragmentNode = varying(vec4(eyeRelativePosition(attribute('tracked', 'vec3')), 1)).setInterpolation('flat');
  material.depthTest = false;
  const mesh = addMesh(stage.scene, geometry, material);
  // T_hi = 2^24 and T_lo = −2^24: (0.5 + 2^24) rounds to 2^24 in float32, so the ordered sum is 0.
  const elements = mesh.matrixWorld.elements;
  for (const i of [12, 13, 14]) elements[i] = 2 ** 24;
  for (const i of [3, 7, 11]) elements[i] = -(2 ** 24);
  const target = floatTarget(1, false);
  try {
    const value = (await drawAndRead(renderer, target, stage))[0] ?? Number.NaN;
    return { value, inOrder: value === 0 };
  } finally {
    target.dispose();
    material.dispose();
    geometry.dispose();
  }
}

/** World-space corners of a plane facing the camera at view distance d, covering one block of the depth grid. */
function planeOffsets(frame: CameraFrame, block: number, distance: number): Float32Array {
  const cell = 2 / DEPTH_GRID;
  const margin = 1 / DEPTH_SIZE;
  const x0 = -1 + (block % DEPTH_GRID) * cell + margin;
  const y0 = -1 + Math.floor(block / DEPTH_GRID) * cell + margin;
  const corners = rectangle(x0, y0, x0 + cell - 2 * margin, y0 + cell - 2 * margin);
  const scale = distance * Math.tan(PROBE_SCREEN.fovYRad / 2);
  return Float32Array.from(corners, (_, i) => {
    const vertex = Math.floor(i / 3);
    const axis = i % 3;
    const x = (corners[vertex * 3] ?? 0) * scale;
    const y = (corners[vertex * 3 + 1] ?? 0) * scale;
    return x * (frame.right[axis] ?? 0) + y * (frame.up[axis] ?? 0);
  });
}

async function depthProbe(renderer: WebGPURenderer, depthPath: DepthPath): Promise<GpuProbeResult['depth']> {
  const distances = depthDistances(DEPTH_GRID * DEPTH_GRID);
  const frame = cameraFrame(Float64Array.of(0.6, -0.48, 0.64), random(3));
  const eye = Float64Array.of(4.4e6, 0.71e6, 4.52e6);
  const stage = probeStage();
  stage.camera.apply({ view: viewMatrix(frame), projection: projectionMatrix(1) }, depthPath);
  // The engine's material: eye-relative vertices and, on the fragment path, the written depth. Red is the plane number.
  const material = new MeshBasicNodeMaterial();
  makeEyeRelative(material, depthPath);
  material.colorNode = vec4(attribute('plane', 'float'), 0, 0, 1);
  material.side = DoubleSide;
  const geometries = distances.map((distance, block) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(planeOffsets(frame, block, distance), 3));
    geometry.setAttribute('plane', new BufferAttribute(new Float32Array(6).fill(block), 1));
    const mesh = addMesh(stage.scene, geometry, material);
    placeEyeRelative(
      mesh,
      eye.map((e, i) => e + (frame.forward[i] ?? 0) * distance),
      eye,
    );
    return geometry;
  });
  const scene = floatTarget(DEPTH_SIZE, true);
  const readout = floatTarget(DEPTH_SIZE, false);
  // A second pass copies depth, plane number and coverage at the same coordinates into a float target.
  const copy = probeStage();
  const quad = new BufferGeometry();
  quad.setAttribute('position', new BufferAttribute(Float32Array.from(rectangle(-1, -1, 1, 1)), 3));
  const copyMaterial = new MeshBasicNodeMaterial();
  copyMaterial.vertexNode = vec4(positionGeometry.xy, 0, 1);
  const color = texture(scene.texture, screenUV);
  copyMaterial.fragmentNode = vec4(texture(scene.depthTexture as DepthTexture, screenUV).x, color.x, color.w, 1);
  copyMaterial.depthTest = false;
  addMesh(copy.scene, quad, copyMaterial);
  try {
    renderer.setRenderTarget(scene);
    renderer.setClearColor(0x000000, 0);
    renderer.render(stage.scene, stage.camera);
    const pixels = await drawAndRead(renderer, readout, copy);
    const seen = new Set<number>();
    let maxRelativeError = 0;
    for (let p = 0; p < pixels.length; p += 4) {
      if ((pixels[p + 2] ?? 0) !== 1) continue;
      const plane = Math.round(pixels[p + 1] ?? -1);
      const distance = distances[plane];
      if (distance === undefined) continue;
      seen.add(plane);
      const reconstructed = PROBE_NEAR_METERS / (pixels[p] ?? 0);
      maxRelativeError = Math.max(maxRelativeError, Math.abs(reconstructed - distance) / distance);
    }
    return { planes: distances.length, missing: distances.length - seen.size, maxRelativeError };
  } finally {
    scene.dispose();
    readout.dispose();
    material.dispose();
    copyMaterial.dispose();
    quad.dispose();
    for (const geometry of geometries) geometry.dispose();
  }
}
