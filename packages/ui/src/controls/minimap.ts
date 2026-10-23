/**
 * The overview minimap (F417): a small equirectangular world image with the main view's footprint, the ground shown
 * along the canvas's edges (`Globe.screenToGeo` at points of each edge, so a tilted view draws its trapezoid). It
 * redraws on each camera change: a few dozen picks and one 2D path, measured in `lastUpdateMs`. It is never added
 * unless the application adds it.
 */
import { geodesicDirect, WGS84, type CameraState, type GeoPosition } from '@vibeglobe/core';
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
  const points: GeoPosition[] = [];
  const edges: readonly (readonly [number, number, number, number])[] = [
    [0, 0, widthPx, 0],
    [widthPx, 0, widthPx, heightPx],
    [widthPx, heightPx, 0, heightPx],
    [0, heightPx, 0, 0],
  ];
  for (const [x0, y0, x1, y1] of edges)
    for (let i = 0; i < samplesPerEdge; i++) {
      const t = i / samplesPerEdge;
      const position = screenToGeo({ xPx: x0 + (x1 - x0) * t, yPx: y0 + (y1 - y0) * t });
      if (position !== undefined) points.push(position);
    }
  return points;
}

/** Points of the eye's horizon on the ellipsoid: the edge of the area the eye can see. */
function horizonCircle(camera: CameraState, samples = 48): GeoPosition[] {
  const radius = WGS84.semiMajorAxisMeters;
  const altitude = Math.max(1, camera.altitudeMeters);
  const distanceMeters = radius * Math.acos(radius / (radius + altitude));
  const points: GeoPosition[] = [];
  for (let i = 0; i < samples; i++) {
    const { longitudeDeg, latitudeDeg } = geodesicDirect(
      camera.eyeLongitudeDeg,
      camera.eyeLatitudeDeg,
      (360 * i) / samples,
      distanceMeters,
    );
    points.push({ longitudeDeg, latitudeDeg });
  }
  return points;
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
    const edges = viewFootprint(
      (point) => globe.screenToGeo(point),
      container.clientWidth,
      container.clientHeight,
      this.#samples,
    );
    // Space along an edge (the globe phase, a view up to the horizon): the visible area reaches the horizon.
    this.#footprint = edges.length === 4 * this.#samples ? edges : horizonCircle(globe.camera);
    const { width, height } = canvas;
    draw.clearRect(0, 0, width, height);
    if (this.#world !== undefined) draw.drawImage(this.#world, 0, 0);
    const points = this.#footprint;
    if (points.length >= 2) {
      // Longitudes unwrapped around the first point, so a footprint across the antimeridian stays one shape.
      const first = points[0]?.longitudeDeg ?? 0;
      const x = (longitudeDeg: number): number => ((longitudeDeg - first + 540) % 360) - 180 + first;
      draw.beginPath();
      for (const [index, point] of points.entries()) {
        const px = ((x(point.longitudeDeg) + 180) / 360) * width;
        const py = ((90 - point.latitudeDeg) / 180) * height;
        if (index === 0) draw.moveTo(px, py);
        else draw.lineTo(px, py);
      }
      draw.closePath();
      draw.fillStyle = 'rgba(255, 64, 64, 0.25)';
      draw.fill();
      draw.lineWidth = Math.max(1, width / this.#widthPx) * 1.5;
      draw.strokeStyle = '#ff4040';
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
