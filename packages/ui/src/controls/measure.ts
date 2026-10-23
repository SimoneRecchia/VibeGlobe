/**
 * The measurement tools (F411), built on the drawing tools: a distance (a line: path length and bearing) or an area (a
 * polygon: area and perimeter), measured on the WGS84 ellipsoid by `@vibeglobe/gis` and shown live while drawing and
 * editing, scaled from meters to kilometers (square meters to square kilometers) and translated.
 */
import { formatArea, formatLength, measureArea, measureDistance, measurePathLength } from '@vibeglobe/gis';
import { DrawingTool } from '../draw/drawing-tool.js';
import type { LonLat, ShapeKind } from '../draw/geometry.js';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { DrawControl } from './draw.js';
import { controlFrame } from './dom.js';

/** Options of {@link MeasureControl}. */
export interface MeasureControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
}

/** A measurement of a line or a polygon. */
export interface Measurement {
  readonly kind: 'line' | 'polygon';
  /** Path length of a line, perimeter of a polygon, meters. */
  readonly lengthMeters: number;
  /** Area of a polygon, square meters (0 for a line). */
  readonly areaSquareMeters: number;
  /** Bearing of a line's last segment, degrees clockwise from north (undefined for a polygon). */
  readonly bearingDeg: number | undefined;
}

/** Measures a line or a polygon through its vertices. */
export function measureShape(kind: 'line' | 'polygon', coordinates: readonly LonLat[]): Measurement {
  const points = coordinates.map(([longitudeDeg, latitudeDeg]) => ({ longitudeDeg, latitudeDeg }));
  if (kind === 'polygon') {
    const { areaSquareMeters, perimeterMeters } = measureArea(points);
    return { kind, lengthMeters: perimeterMeters, areaSquareMeters, bearingDeg: undefined };
  }
  const a = points.at(-2);
  const b = points.at(-1);
  const bearingDeg = a && b ? measureDistance(a, b).initialBearingDeg : undefined;
  return { kind, lengthMeters: measurePathLength(points), areaSquareMeters: 0, bearingDeg };
}

/** The measurement toolbar (distance, area, edit) and its live readout. */
export class MeasureControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  /** The drawing tool holding the measured shapes. */
  readonly tool = new DrawingTool();
  readonly #draw: DrawControl;
  #context: ControlContext | undefined;
  #readout: HTMLElement | undefined;
  #measurement: Measurement | undefined;
  #stops: (() => void)[] = [];

  /** @param options - Placement; every field is optional. */
  constructor(options: MeasureControlOptions = {}) {
    this.id = options.id ?? 'measure';
    this.position = options.position ?? 'top-left';
    this.#draw = new DrawControl({
      id: `${this.id}-draw`,
      tool: this.tool,
      modes: ['line', 'polygon', 'edit'],
      labels: { line: 'measure.distance', polygon: 'measure.area' },
      toolbarLabel: 'measure.label',
    });
  }

  /** The measurement shown now. */
  get measurement(): Measurement | undefined {
    return this.#measurement;
  }

  /** The toolbar's drawing control. */
  get draw(): DrawControl {
    return this.#draw;
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('measure');
    const toolbar = this.#draw.mount(context);
    toolbar.classList.add('vg-ui__measure-tools');
    const readout = document.createElement('div');
    readout.className = 'vg-ui__measure-readout';
    readout.setAttribute('role', 'status');
    frame.append(toolbar, readout);
    this.#readout = readout;
    const measure = (kind: ShapeKind, coordinates: readonly LonLat[]): void => {
      if (kind !== 'point') this.#show(measureShape(kind, coordinates));
    };
    this.#stops.push(
      this.tool.on('draft', ({ kind, coordinates }) => measure(kind, coordinates)),
      this.tool.on('create', ({ feature }) =>
        measure(feature.properties.kind, this.tool.shape(feature.id)?.coordinates ?? []),
      ),
      this.tool.on('change', ({ feature }) =>
        measure(feature.properties.kind, this.tool.shape(feature.id)?.coordinates ?? []),
      ),
    );
    return frame;
  }

  /** Updates texts to the current language (UiControl). */
  localize(): void {
    this.#draw.localize();
    this.#show(this.#measurement);
  }

  /** Releases the drawing control (UiControl). */
  destroy(): void {
    for (const stop of this.#stops) stop();
    this.#stops = [];
    this.#draw.destroy();
    this.#context = undefined;
  }

  #show(measurement: Measurement | undefined): void {
    this.#measurement = measurement;
    const i18n = this.#context?.i18n;
    if (this.#readout === undefined || i18n === undefined) return;
    if (measurement === undefined) {
      this.#readout.replaceChildren();
      return;
    }
    const language = i18n.language;
    const lines =
      measurement.kind === 'polygon'
        ? [
            i18n.t('measure.areaValue', { area: formatArea(measurement.areaSquareMeters, language) }),
            i18n.t('measure.perimeter', { length: formatLength(measurement.lengthMeters, language) }),
          ]
        : [
            i18n.t('measure.length', { length: formatLength(measurement.lengthMeters, language) }),
            ...(measurement.bearingDeg === undefined
              ? []
              : [
                  i18n.t('measure.bearing', {
                    bearing: `${i18n.formatNumber(measurement.bearingDeg, { maximumFractionDigits: 1 })}°`,
                  }),
                ]),
          ];
    this.#readout.replaceChildren(
      ...lines.map((text) => {
        const line = document.createElement('div');
        line.textContent = text;
        return line;
      }),
    );
  }
}
