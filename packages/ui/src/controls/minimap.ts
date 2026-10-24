// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The overview minimap (F417): a small equirectangular world image with the main view's footprint, the ground shown
 * along the canvas's edges (`Globe.screenToGeo` at points of each edge, so a tilted view draws its trapezoid). It
 * redraws on each camera change: a few dozen picks and one 2D path, measured in `lastUpdateMs`. It is never added
 * unless the application adds it.
 */
import { themeValue } from '../theme/value.js';
import { WGS84, type CameraState, type GeoPosition } from '@vibeglobe/core';
import { geodesicDirect, geodesicInverse } from '@vibeglobe/core/geodesy';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame } from './dom.js';

/** Options of {@link MinimapControl}. */
export interface MinimapControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  /** An equirectangular image of the whole world (for example the engine's base image). */
  readonly imageUrl: string;
  /** Width of the minimap in CSS pixels (default 160; the height is half of it). */
  readonly widthPx?: number;
  /** Points sampled along each edge of the main view (default 8). */
  readonly samplesPerEdge?: number;
}

/** The ground shown along the edges of a `widthPx` × `heightPx` view, clockwise from the top left; off-globe points left out. */
export function viewFootprint(
  screenToGeo: (point: { xPx: number; yPx: number }) => GeoPosition | undefined,
  widthPx: number,
  heightPx: number,
  samplesPerEdge: number,
): GeoPosition[] {
  return edgeSamples(screenToGeo, widthPx, heightPx, samplesPerEdge).filter((point) => point !== undefined);
}

/** {@link viewFootprint}'s samples, `undefined` where the edge shows no ground. */
function edgeSamples(
  screenToGeo: (point: { xPx: number; yPx: number }) => GeoPosition | undefined,
  widthPx: number,
  heightPx: number,
  samplesPerEdge: number,
): (GeoPosition | undefined)[] {
  const points: (GeoPosition | undefined)[] = [];
  const edges: readonly (readonly [number, number, number, number])[] = [
    [0, 0, widthPx, 0],
    [widthPx, 0, widthPx, heightPx],
    [widthPx, heightPx, 0, heightPx],
    [0, heightPx, 0, 0],
  ];
  for (const [x0, y0, x1, y1] of edges)
    for (let i = 0; i < samplesPerEdge; i++) {
      const t = i / samplesPerEdge;
      points.push(screenToGeo({ xPx: x0 + (x1 - x0) * t, yPx: y0 + (y1 - y0) * t }));
    }
  return points;
}

/** An angle difference in [-180, 180) degrees. */
const wrap180 = (deg: number): number => (((deg % 360) + 540) % 360) - 180;

/** `steps` + 1 points of the eye's horizon on the ellipsoid from one azimuth to another (degrees, clockwise). */
function horizonArc(camera: CameraState, fromDeg: number, toDeg: number, steps = 12): GeoPosition[] {
  const radius = WGS84.semiMajorAxisMeters;
  const altitude = Math.max(1, camera.altitudeMeters);
  const distanceMeters = radius * Math.acos(radius / (radius + altitude));
  const points: GeoPosition[] = [];
  for (let i = 0; i <= steps; i++) {
    const { longitudeDeg, latitudeDeg } = geodesicDirect(
      camera.eyeLongitudeDeg,
      camera.eyeLatitudeDeg,
      fromDeg + ((toDeg - fromDeg) * i) / steps,
      distanceMeters,
    );
    points.push({ longitudeDeg, latitudeDeg });
  }
  return points;
}

/**
 * The visible area's outline from the view's edge samples (`undefined` where an edge shows no ground): the samples,
 * and the horizon where the edges show sky or space, as the short arc between the ground points on either side (a
 * tilted view's far edge, KB-169); the whole horizon when no edge shows ground (the globe phase).
 */
export function footprintOutline(camera: CameraState, samples: readonly (GeoPosition | undefined)[]): GeoPosition[] {
  const azimuth = (point: GeoPosition): number =>
    geodesicInverse(camera.eyeLongitudeDeg, camera.eyeLatitudeDeg, point.longitudeDeg, point.latitudeDeg)
      .initialAzimuthDeg;
  const start = samples.findIndex((point) => point !== undefined);
  if (start < 0) return horizonArc(camera, 0, 352.5, 47);
  const outline: GeoPosition[] = [];
  for (let k = 0; k < samples.length; k++) {
    const point = samples[(start + k) % samples.length];
    if (point !== undefined) {
      outline.push(point);
      continue;
    }
    let end = k;
    while (samples[(start + end + 1) % samples.length] === undefined) end++;
    const before = outline.at(-1);
    const after = samples[(start + end + 1) % samples.length];
    if (before !== undefined && after !== undefined) {
      const from = azimuth(before);
      const turn = wrap180(azimuth(after) - from);
      outline.push(...horizonArc(camera, from, from + turn));
    }
    k = end;
  }
  return outline;
}

/**
 * The outline's longitudes, each unwrapped from the one before (so a footprint across the antimeridian stays one
 * shape), and the pole the outline goes around (1 north, -1 south, 0 none: its longitudes turn by a full 360°, KB-169).
 */
export function unwrapOutline(points: readonly GeoPosition[]): { longitudesDeg: number[]; pole: number } {
  const longitudesDeg: number[] = [];
  let previous = points[0]?.longitudeDeg ?? 0;
  for (const point of points) {
    previous += wrap180(point.longitudeDeg - previous);
    longitudesDeg.push(previous);
  }
  const first = longitudesDeg[0] ?? 0;
  const last = longitudesDeg.at(-1) ?? 0;
  const turn = last + wrap180(first - last) - first;
  return { longitudesDeg, pole: Math.abs(turn) > 180 ? Math.sign(points[0]?.latitudeDeg ?? 1) : 0 };
}

/** A canvas with the world and the footprint outline. */
export class MinimapControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  readonly #imageUrl: string;
  readonly #widthPx: number;
  readonly #samples: number;
  #context: ControlContext | undefined;
  #canvas: HTMLCanvasElement | undefined;
  /** The world image scaled once to the minimap's size, so an update copies pixels instead of resampling it. */
  #world: HTMLCanvasElement | undefined;
  #stop: (() => void) | undefined;
  #footprint: GeoPosition[] = [];
  #lastUpdateMs = 0;

  /** @param options - The world image, placement and size. */
  constructor(options: MinimapControlOptions) {
    this.id = options.id ?? 'minimap';
    this.position = options.position ?? 'bottom-right';
    this.#imageUrl = options.imageUrl;
    this.#widthPx = options.widthPx ?? 160;
    this.#samples = options.samplesPerEdge ?? 8;
  }

  /** The footprint of the last update, clockwise from the main view's top left. */
  get footprint(): readonly GeoPosition[] {
    return this.#footprint;
  }

  /** The time the last update took, in milliseconds (its per-frame cost). */
  get lastUpdateMs(): number {
    return this.#lastUpdateMs;
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('minimap');
    const canvas = document.createElement('canvas');
    canvas.className = 'vg-ui__minimap-canvas';
    canvas.setAttribute('role', 'img');
    const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    canvas.width = Math.round(this.#widthPx * ratio);
    canvas.height = Math.round((this.#widthPx / 2) * ratio);
    canvas.style.width = `${this.#widthPx}px`;
    canvas.style.height = `${this.#widthPx / 2}px`;
    frame.append(canvas);
    this.#canvas = canvas;
    const image = new Image();
    image.onload = () => {
      const world = document.createElement('canvas');
      world.width = canvas.width;
      world.height = canvas.height;
      world.getContext('2d')?.drawImage(image, 0, 0, world.width, world.height);
      this.#world = world;
      this.update();
    };
    image.src = this.#imageUrl;
    this.#stop = context.globe.on('camera-change', () => this.update());
    queueMicrotask(() => this.update());
    return frame;
  }

  /** Measures the footprint of the main view and redraws. */
  update(): void {
    const context = this.#context;
    const canvas = this.#canvas;
    const draw = canvas?.getContext('2d');
    if (context === undefined || canvas === undefined || draw === undefined || draw === null) return;
    const started = performance.now();
    const { container, globe } = context;
    const edges = edgeSamples(
      (point) => globe.screenToGeo(point),
      container.clientWidth,
      container.clientHeight,
      this.#samples,
    );
    this.#footprint = footprintOutline(globe.camera, edges);
    const { width, height } = canvas;
    draw.clearRect(0, 0, width, height);
    if (this.#world !== undefined) draw.drawImage(this.#world, 0, 0);
    const points = this.#footprint;
    if (points.length >= 2) {
      const { longitudesDeg, pole } = unwrapOutline(points);
      const px = (longitudeDeg: number): number => ((longitudeDeg + 180) / 360) * width;
      draw.beginPath();
      // Once per world copy the unwrapped outline may reach, so the part past the map's edge shows on the other side.
      for (const shift of [-360, 0, 360]) {
        for (const [index, point] of points.entries()) {
          const x = px((longitudesDeg[index] ?? 0) + shift);
          const y = ((90 - point.latitudeDeg) / 180) * height;
          if (index === 0) draw.moveTo(x, y);
          else draw.lineTo(x, y);
        }
        // Around a pole, the outline closes along the map's top or bottom edge (KB-169).
        if (pole !== 0) {
          const y = pole > 0 ? 0 : height;
          draw.lineTo(px((longitudesDeg.at(-1) ?? 0) + shift), y);
          draw.lineTo(px((longitudesDeg[0] ?? 0) + shift), y);
        }
        draw.closePath();
      }
      const color = themeValue(context.container, '--vg-ui-minimap-footprint-color');
      draw.fillStyle = color;
      draw.globalAlpha = 0.25;
      draw.fill();
      draw.globalAlpha = 1;
      draw.lineWidth = Math.max(1, width / this.#widthPx) * 1.5;
      draw.strokeStyle = color;
      draw.stroke();
    }
    this.#lastUpdateMs = performance.now() - started;
  }

  /** Updates the accessible name to the current language (UiControl). */
  localize(): void {
    this.#canvas?.setAttribute('aria-label', this.#context?.i18n.t('minimap.label') ?? '');
  }

  /** Releases listeners (UiControl). */
  destroy(): void {
    this.#stop?.();
    this.#context = undefined;
  }
}
