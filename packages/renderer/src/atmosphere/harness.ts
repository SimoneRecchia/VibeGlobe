// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// The atmosphere harness (e2e/support/atmosphere.html installs it as `window.atmosphereHarness`), driven by the
// atmosphere track's end-to-end tests. Test code, not exported by the package: it sits here because the end-to-end
// TypeScript project cannot import the renderer's sources. Until the main session wires the atmosphere into the engine's frame loop
// (docs/parallel-tracks.md, "Atmosphere hook"), it draws the WGS84 ellipsoid with the playground's base imagery the way
// the engine does (eye-relative vertices, reversed-Z, the engine's camera) and the atmosphere exactly as the hook
// describes: the sky mesh in the scene, the surface color wrapped, `update` before each render.
import { Camera, geodeticToEcef, MorphFrame, type CameraPose, type FrameView } from '@vibeglobe/core';
import { eyeRelativePosition, makeEyeRelative, placeEyeRelative } from '../eye-relative.js';
import { depthPathOf } from '../depth.js';
import { captureCanvas } from '../canvas-slot.js';
import { ATMOSPHERE_QUALITY } from './atmosphere-model.js';
import {
  Atmosphere,
  createAtmosphereFrame,
  ecefVisibility,
  globeFrame,
  morphFrame,
  type AtmosphereOptions,
} from './atmosphere.js';
import { subsolarPoint, type SubsolarPoint } from './sun-position.js';
import { attribute, positionGeometry, texture, vec4 } from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Scene,
  SRGBColorSpace,
  Texture,
  WebGPURenderer,
  type Camera as ThreeCamera,
} from 'three/webgpu';
import { EngineCamera } from '../engine-camera.js';
import { patchIdentitySwizzle } from '../webgpu-compat.js';

/** The globe's morph frame (factor 0): the harness draws the globe, never the flat map. */
const GLOBE = new MorphFrame();

/** What a test starts. */
interface AtmosphereHarnessConfig {
  readonly backend: 'webgpu' | 'webgl2';
  /** 'fragment' forces the WebGL2 fragment-depth path (ADR 0005 §4). */
  readonly depth?: 'auto' | 'fragment';
  /** False draws the same globe without any atmosphere, for comparisons. */
  readonly atmosphere?: boolean;
  /**
   * Paints the imagery's 10° tiles alternately 35% darker, standing in for neighboring tiles of different detail:
   * the seam check measures how much of that step survives the haze near the horizon (F394).
   */
  readonly tileSteps?: boolean;
}

/** Camera pose in degrees and meters, as tests write it. */
interface HarnessPose {
  readonly lonDeg: number;
  readonly latDeg: number;
  readonly heightM?: number;
  readonly rangeM: number;
  readonly headingDeg?: number;
  readonly tiltDeg?: number;
}

/** Atmosphere options as tests write them. */
interface HarnessOptions {
  readonly sunLighting?: boolean;
  readonly timeUtc?: string;
  readonly haze?: number;
  readonly quality?: keyof typeof ATMOSPHERE_QUALITY;
  readonly dither?: boolean;
}

/** A rendered frame: RGBA, top row first, as base64. */
interface Frame {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly base64: string;
}

/** What the page offers its tests as `window.atmosphereHarness`. */
export interface AtmosphereHarness {
  start(config: AtmosphereHarnessConfig): Promise<{ backend: string; depthPath: string }>;
  setView(pose: HarnessPose): void;
  setOptions(options: HarnessOptions): void;
  /** Blends the atmosphere toward a flat view (F393): 0 globe, 1 flat. */
  setFlatness(flatness: number): void;
  /** Renders a frame and returns it, RGBA as base64. */
  frame(): Promise<Frame>;
  /** Screen position of a geodetic point, CSS pixels from the top left, or null behind the eye. */
  project(lonDeg: number, latDeg: number): { x: number; y: number } | null;
  /** The sub-solar point at a time (F396), degrees. */
  subsolar(timeUtc: string): SubsolarPoint;
  /** The fog visibility the engine's tile detail would use for a point (F395). */
  visibility(lonDeg: number, latDeg: number): number;
  stop(): void;
}

const DEG = Math.PI / 180;

/** The ellipsoid as one mesh of 512 × 256 cells, vertices relative to the Earth's center (fine for test views). */
export function ellipsoidGeometry(): BufferGeometry {
  const columns = 512;
  const rows = 256;
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  const uvs = new Float32Array((columns + 1) * (rows + 1) * 2);
  const point = new Float64Array(3);
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const i = row * (columns + 1) + column;
      const lon = (column / columns) * 2 * Math.PI - Math.PI;
      const lat = Math.PI / 2 - (row / rows) * Math.PI;
      geodeticToEcef(lon, lat, 0, point);
      positions.set(point, i * 3);
      uvs[i * 2] = column / columns;
      uvs[i * 2 + 1] = 1 - row / rows;
    }
  }
  const indices = new Uint32Array(columns * rows * 6);
  let k = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * (columns + 1) + column;
      const b = a + columns + 1;
      indices.set([a, b, a + 1, a + 1, b, b + 1], k);
      k += 6;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('imageryUv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

/** The playground's base imagery, optionally checkered (see `tileSteps`). */
async function loadImagery(tileSteps: boolean): Promise<Texture> {
  const bitmap = await createImageBitmap(await (await fetch('/imagery/natural-earth-4096.jpg')).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2D context');
  context.drawImage(bitmap, 0, 0);
  if (tileSteps) {
    const tile = bitmap.width / 36;
    context.fillStyle = 'rgba(0, 0, 0, 0.35)';
    for (let y = 0; y < 18; y++) {
      for (let x = 0; x < 36; x++) if ((x + y) % 2 === 0) context.fillRect(x * tile, y * tile, tile, tile);
    }
  }
  const map = new Texture(canvas);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = 16;
  map.needsUpdate = true;
  return map;
}

/**
 * Screen position in CSS pixels of an ECEF point for a camera, from its view and projection matrices; null behind
 * the eye. The tests use it to find where a meridian, a tile boundary or the terminator falls on screen.
 */
export function projectPx(camera: Camera, ecef: Float64Array): { x: number; y: number } | null {
  const v = camera.view;
  const p = camera.projection;
  const rel = [0, 1, 2].map((i) => (ecef[i] ?? 0) - (camera.eyeEcef[i] ?? 0));
  const view = [0, 1, 2].map(
    (row) => (v[row] ?? 0) * (rel[0] ?? 0) + (v[4 + row] ?? 0) * (rel[1] ?? 0) + (v[8 + row] ?? 0) * (rel[2] ?? 0),
  );
  const z = view[2] ?? 0;
  if (z >= 0) return null;
  const x = ((p[0] ?? 1) * (view[0] ?? 0) + (p[8] ?? 0) * z) / -z;
  const y = ((p[5] ?? 1) * (view[1] ?? 0) + (p[9] ?? 0) * z) / -z;
  return { x: ((x + 1) / 2) * camera.widthPx, y: ((1 - y) / 2) * camera.heightPx };
}

/** Reads a canvas's frame as base64 RGBA. */
async function readFrame(canvas: HTMLCanvasElement): Promise<Frame> {
  const capture = await captureCanvas(canvas);
  const bytes = new Uint8Array(capture.rgba.buffer, capture.rgba.byteOffset, capture.rgba.byteLength);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return { widthPx: capture.widthPx, heightPx: capture.heightPx, base64: btoa(binary) };
}

/** The harness on a page: the ellipsoid with imagery, and the atmosphere wired as `docs/parallel-tracks.md` says. */
class HarnessPage implements AtmosphereHarness {
  private renderer: WebGPURenderer | undefined;
  private atmosphere: Atmosphere | undefined;
  private readonly scene = new Scene();
  private readonly engineCamera = new EngineCamera();
  private readonly camera = new Camera();
  private readonly origin = new Float64Array(3);
  private readonly atmosphereFrame = createAtmosphereFrame();
  private globe: Mesh | undefined;
  private flatness = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.scene.matrixWorldAutoUpdate = false;
    this.engineCamera.matrixAutoUpdate = false;
    this.engineCamera.matrixWorldAutoUpdate = false;
  }

  async start(config: AtmosphereHarnessConfig): Promise<{ backend: string; depthPath: string }> {
    const renderer = await this.createRenderer(config);
    const depthPath = depthPathOf(renderer);
    const material = new MeshBasicNodeMaterial();
    const imagery = await loadImagery(config.tileSteps ?? false);
    const color = texture(imagery, attribute('imageryUv', 'vec2')).xyz;
    material.colorNode = vec4(color, 1);
    makeEyeRelative(material, depthPath);
    if (config.atmosphere !== false) {
      this.atmosphere = new Atmosphere(depthPath);
      material.colorNode = vec4(this.atmosphere.surfaceColor(color, eyeRelativePosition(positionGeometry)), 1);
    }
    const globe = new Mesh(ellipsoidGeometry(), material);
    globe.frustumCulled = false;
    globe.matrixAutoUpdate = false;
    globe.matrixWorldAutoUpdate = false;
    this.globe = globe;
    this.scene.add(globe);
    if (this.atmosphere) this.scene.add(this.atmosphere.sky);
    const backend = (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend ? 'webgl2' : 'webgpu';
    return { backend, depthPath };
  }

  /** A renderer set up like the engine's (ADR 0005, ADR 0010), sized to the canvas. */
  private async createRenderer(config: AtmosphereHarnessConfig): Promise<WebGPURenderer> {
    if (config.backend === 'webgpu') patchIdentitySwizzle(window);
    const renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: true,
      reversedDepthBuffer: config.backend === 'webgpu' || (config.depth ?? 'auto') === 'auto',
      forceWebGL: config.backend === 'webgl2',
    });
    await renderer.init();
    if (depthPathOf(renderer) === 'fragment') renderer.setClearDepth(0);
    renderer.lighting.enabled = false;
    renderer.sortObjects = false;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(1);
    renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight, false);
    this.camera.widthPx = this.canvas.clientWidth;
    this.camera.heightPx = this.canvas.clientHeight;
    this.renderer = renderer;
    return renderer;
  }

  setView(pose: HarnessPose): void {
    const p: CameraPose = this.camera.pose;
    p.targetLongitudeRad = pose.lonDeg * DEG;
    p.targetLatitudeRad = pose.latDeg * DEG;
    p.targetHeightMeters = pose.heightM ?? 0;
    p.rangeMeters = pose.rangeM;
    p.headingRad = (pose.headingDeg ?? 0) * DEG;
    p.tiltRad = (pose.tiltDeg ?? 0) * DEG;
    p.rollRad = 0;
    this.camera.update();
  }

  setOptions(options: HarnessOptions): void {
    const quality = ATMOSPHERE_QUALITY[options.quality ?? 'high'];
    const next: Partial<AtmosphereOptions> = {
      ...(options.sunLighting !== undefined ? { sunLighting: options.sunLighting } : {}),
      ...(options.timeUtc !== undefined ? { timeMs: Date.parse(options.timeUtc) } : {}),
      ...(options.haze !== undefined ? { haze: options.haze } : {}),
      quality: options.dither === false ? { ...quality, dither: false } : quality,
    };
    this.atmosphere?.setOptions(next);
  }

  setFlatness(flatness: number): void {
    this.flatness = flatness;
  }

  async frame(): Promise<Frame> {
    const renderer = this.renderer;
    if (!renderer || !this.globe) throw new Error('not started');
    const view: FrameView = {
      morph: GLOBE,
      view: this.camera.view,
      projection: this.camera.projection,
      eyeEcef: this.camera.eyeEcef,
      widthPx: this.camera.widthPx,
      heightPx: this.camera.heightPx,
      pixelRatio: 1,
    };
    placeEyeRelative(this.globe, this.origin, view.eyeEcef);
    if (this.flatness > 0) {
      const f = globeFrame(view.eyeEcef, this.atmosphereFrame);
      // The engine's morph supplies its own height and up; here the globe's, with the curvature blended away.
      this.atmosphere?.update(view, morphFrame(this.flatness, f.eyeAltitudeM, f.up, f));
    } else {
      this.atmosphere?.update(view);
    }
    this.engineCamera.apply(view, depthPathOf(renderer));
    renderer.render(this.scene, this.engineCamera as ThreeCamera);
    return readFrame(this.canvas);
  }

  project(lonDeg: number, latDeg: number): { x: number; y: number } | null {
    return projectPx(this.camera, geodeticToEcef(lonDeg * DEG, latDeg * DEG, 0, new Float64Array(3)));
  }

  subsolar(timeUtc: string): SubsolarPoint {
    return subsolarPoint(Date.parse(timeUtc));
  }

  visibility(lonDeg: number, latDeg: number): number {
    return ecefVisibility(this.camera.eyeEcef, geodeticToEcef(lonDeg * DEG, latDeg * DEG, 0, new Float64Array(3)));
  }

  stop(): void {
    this.atmosphere?.dispose();
    this.renderer?.dispose();
  }
}

/** Creates the harness on a page whose canvas has the id `globe`. */
export function createAtmosphereHarness(document: Document): AtmosphereHarness {
  const canvas = document.querySelector<HTMLCanvasElement>('#globe');
  if (!canvas) throw new Error('no canvas #globe');
  return new HarnessPage(canvas);
}
