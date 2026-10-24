// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The overview minimap (F417): a small equirectangular world image with the main view's footprint, the ground shown
 * along the canvas's edges (`Globe.screenToGeo` at points of each edge, so a tilted view draws its trapezoid). It
 * redraws on each camera change: a few dozen picks and one 2D path, measured in `lastUpdateMs`. It is never added
 * unless the application adds it.
 */
import { themeValue } from '../theme/value.js';
import { WGS84, type CameraState, type GeoPosition, type Globe } from '@vibeglobe/core';
import { geodesicDirect } from '@vibeglobe/core/geodesy';
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
export function footprintOutline(
  camera: CameraState,
  samples: readonly (GeoPosition | undefined)[],
  aroundEye = false,
): GeoPosition[] {
  // Each point's azimuth from the eye: the spherical bearing, ample for a minimap and cheap (F417's per-frame cost).
  const toRad = Math.PI / 180;
  const eyeLat = camera.eyeLatitudeDeg * toRad;
  const azimuth = (point: GeoPosition): number => {
    const lat = point.latitudeDeg * toRad;
    const dLon = (point.longitudeDeg - camera.eyeLongitudeDeg) * toRad;
    const y = Math.sin(dLon) * Math.cos(lat);
    const x = Math.cos(eyeLat) * Math.sin(lat) - Math.sin(eyeLat) * Math.cos(lat) * Math.cos(dLon);
    return Math.atan2(y, x) / toRad;
  };
  const start = samples.findIndex((point) => point !== undefined);
  if (start < 0) return horizonArc(camera, 0, 352.5, 47);
  // The ground runs, each followed by the sky run after it, as the azimuths it turns through.
  const runs: { points: GeoPosition[]; from: number; turn: number }[] = [];
  let total = 0;
  for (let k = 0; k < samples.length; k++) {
    const point = samples[(start + k) % samples.length];
    const run = runs.at(-1);
    if (point !== undefined) {
      if (run === undefined || run.turn !== 0) runs.push({ points: [point], from: 0, turn: 0 });
      else {
        // The ground's own turn counts only for an outline around the eye.
        if (aroundEye) total += wrap180(azimuth(point) - azimuth(run.points.at(-1) ?? point));
        run.points.push(point);
      }
      continue;
    }
    let end = k;
    while (samples[(start + end + 1) % samples.length] === undefined) end++;
    const after = samples[(start + end + 1) % samples.length];
    if (run !== undefined && after !== undefined) {
      run.from = azimuth(run.points.at(-1) ?? after);
      run.turn = wrap180(azimuth(after) - run.from) || 1e-9;
      total += run.turn;
    }
    k = end;
  }
  // A view of the eye's nadir encloses the eye: the outline winds once around it, the largest sky run the long way
  // (a globe that touches only one edge of the screen).
  if (aroundEye && Math.abs(total) < 180) {
    const widest = runs.reduce(
      (best, run) => (Math.abs(run.turn) > Math.abs(best.turn) ? run : best),
      runs[0] ?? { turn: 0 },
    );
    if ('from' in widest && widest.turn !== 0) widest.turn -= Math.sign(widest.turn) * 360;
  }
  return runs.flatMap((run) =>
    run.turn === 0 ? run.points : [...run.points, ...horizonArc(camera, run.from, run.from + run.turn, 24)],
  );
}

/**
 * The outline's longitudes, each unwrapped from the one before (so a footprint across the antimeridian stays one
 * shape), and whether it goes around a pole (its longitudes turn by a full 360°, KB-169).
 */
export function unwrapOutline(points: readonly GeoPosition[]): { longitudesDeg: number[]; aroundPole: boolean } {
  const longitudesDeg: number[] = [];
  let previous = points[0]?.longitudeDeg ?? 0;
  for (const point of points) {
    previous += wrap180(point.longitudeDeg - previous);
    longitudesDeg.push(previous);
  }
  const first = longitudesDeg[0] ?? 0;
  const last = longitudesDeg.at(-1) ?? 0;
  const turn = last + wrap180(first - last) - first;
  return { longitudesDeg, aroundPole: Math.abs(turn) > 180 };
}

/** Whether the ground under the eye is on the screen (the globe phase): the visible area then surrounds the eye. */
function nadirOnScreen(globe: Globe, container: HTMLElement): boolean {
  const { eyeLongitudeDeg, eyeLatitudeDeg } = globe.camera;
  const nadir = globe.geoToScreen({ longitudeDeg: eyeLongitudeDeg, latitudeDeg: eyeLatitudeDeg });
  if (nadir === undefined) return false;
  return nadir.xPx >= 0 && nadir.yPx >= 0 && nadir.xPx <= container.clientWidth && nadir.yPx <= container.clientHeight;
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
    this.#footprint = footprintOutline(globe.camera, edges, nadirOnScreen(globe, container));
    const { width, height } = canvas;
    draw.clearRect(0, 0, width, height);
    if (this.#world !== undefined) draw.drawImage(this.#world, 0, 0);
    const points = this.#footprint;
    if (points.length >= 2) {
      const { longitudesDeg, aroundPole } = unwrapOutline(points);
      const px = (longitudeDeg: number): number => ((longitudeDeg + 180) / 360) * width;
      // Once per world copy the unwrapped outline may reach, so the part past the map's edge shows on the other side.
      // Around a pole (the eye's), the fill closes along the map's top or bottom edge; the stroke shows the outline only.
      const outline = (fill: boolean): void => {
        draw.beginPath();
        for (const shift of [-360, 0, 360]) {
          for (const [index, point] of points.entries()) {
            const x = px((longitudesDeg[index] ?? 0) + shift);
            const y = ((90 - point.latitudeDeg) / 180) * height;
            if (index === 0) draw.moveTo(x, y);
            else draw.lineTo(x, y);
          }
          if (!aroundPole) draw.closePath();
          else if (fill) {
            const y = globe.camera.eyeLatitudeDeg >= 0 ? 0 : height;
            draw.lineTo(px((longitudesDeg.at(-1) ?? 0) + shift), y);
            draw.lineTo(px((longitudesDeg[0] ?? 0) + shift), y);
          }
        }
      };
      const color = themeValue(context.container, '--vg-ui-minimap-footprint-color');
      outline(true);
      draw.fillStyle = color;
      draw.globalAlpha = 0.25;
      draw.fill();
      draw.globalAlpha = 1;
      outline(false);
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
