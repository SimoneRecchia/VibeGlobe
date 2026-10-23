/**
 * Geolocation (F413): a toggle button that watches the device's position, shows it as a point with its accuracy as a
 * geodesic circle (data layers, F351, F356) and flies there once (`Globe.flyTo`, which keeps the view mode, F201). The
 * marker follows later positions without moving the camera. A denied or unavailable position shows a translated
 * message and leaves the map as it is.
 */
import type { DataLayer, Feature } from '@vibeglobe/layers';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { formatLength } from '@vibeglobe/gis';
import { controlFrame, icon, iconButton, ICONS, label } from './dom.js';

/** Options of {@link GeolocationControl}. */
export interface GeolocationControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  /** The zoom of the flight to the first position (default 15). */
  readonly zoom?: number;
  /** The position source; by default `navigator.geolocation`. */
  readonly geolocation?: Geolocation;
}

type Status = 'idle' | 'locating' | 'found' | 'denied' | 'unavailable';

const MARKER_ID = 'position';

/** A toggle button, the position marker and accuracy circle, and a status line. */
export class GeolocationControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  readonly #zoom: number;
  readonly #geolocation: Geolocation | undefined;
  #context: ControlContext | undefined;
  #button: HTMLButtonElement | undefined;
  #status: HTMLElement | undefined;
  #state: Status = 'idle';
  #watch: number | undefined;
  #flown = false;
  #accuracyMeters = 0;
  #marker: { point: DataLayer; circle: DataLayer } | undefined;
  #last: GeolocationPosition | undefined;

  /** @param options - Placement, zoom and position source; every field is optional. */
  constructor(options: GeolocationControlOptions = {}) {
    this.id = options.id ?? 'geolocation';
    this.position = options.position ?? 'top-right';
    this.#zoom = options.zoom ?? 15;
    this.#geolocation = options.geolocation ?? (typeof navigator === 'undefined' ? undefined : navigator.geolocation);
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('geolocation');
    const button = iconButton('geolocate', icon(ICONS.locate));
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => (this.active ? this.stop() : this.start()));
    const status = document.createElement('div');
    status.className = 'vg-ui__status';
    status.setAttribute('role', 'status');
    frame.append(button, status);
    this.#button = button;
    this.#status = status;
    return frame;
  }

  /** Whether the position is being watched. */
  get active(): boolean {
    return this.#watch !== undefined;
  }

  /** The current state: 'locating', 'found', 'denied', 'unavailable' or 'idle'. */
  get state(): Status {
    return this.#state;
  }

  /** Starts watching the position. */
  start(): void {
    if (this.active || this.#context === undefined) return;
    const geolocation = this.#geolocation;
    if (geolocation === undefined) {
      this.#setState('unavailable');
      return;
    }
    this.#flown = false;
    this.#setState('locating');
    this.#watch = geolocation.watchPosition(
      (position) => void this.#onPosition(position),
      (error) => {
        // A denial ends the watch; a position missing for a while (timeout, no signal) keeps the last one shown.
        if (error.code === error.PERMISSION_DENIED) {
          this.stop();
          this.#setState('denied');
        } else if (this.#state !== 'found') this.#setState('unavailable');
      },
      { enableHighAccuracy: true },
    );
  }

  /** Stops watching and removes the marker. */
  stop(): void {
    if (this.#watch !== undefined) this.#geolocation?.clearWatch(this.#watch);
    this.#watch = undefined;
    this.#removeMarker();
    this.#setState('idle');
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    this.#setState(this.#state);
  }

  /** Stops watching and releases the marker (UiControl). */
  destroy(): void {
    this.stop();
    this.#context = undefined;
  }

  async #onPosition(position: GeolocationPosition): Promise<void> {
    const context = this.#context;
    if (context === undefined || !this.active) return;
    this.#last = position;
    const { longitude, latitude, accuracy } = position.coords;
    this.#accuracyMeters = accuracy;
    this.#setState('found');
    if (!this.#flown) {
      this.#flown = true;
      void context.globe.flyTo({ longitudeDeg: longitude, latitudeDeg: latitude, zoom: this.#zoom });
    }
    const marker = await this.#ensureMarker();
    // A newer position arrived while the layers loaded: it draws instead.
    if (marker === undefined || this.#last !== position || !this.active) return;
    const geometry = { type: 'Point' as const, coordinates: [longitude, latitude] };
    const point: Feature = { type: 'Feature', id: MARKER_ID, geometry, properties: {} };
    if (!marker.point.updateFeature(MARKER_ID, { position: [longitude, latitude] })) marker.point.addFeatures([point]);
    const circle = { ...point, properties: { radiusMeters: accuracy } };
    if (!marker.circle.updateFeature(MARKER_ID, { geometry, properties: circle.properties }))
      marker.circle.addFeatures([circle]);
  }

  async #ensureMarker(): Promise<{ point: DataLayer; circle: DataLayer } | undefined> {
    if (this.#marker !== undefined) return this.#marker;
    const context = this.#context;
    if (context === undefined) return undefined;
    const [layers, { circleLayer, pointLayer }] = await Promise.all([context.layers(), import('@vibeglobe/layers')]);
    if (this.#marker !== undefined || !this.active) return this.#marker;
    const circle = layers.stack.add(
      circleLayer({
        id: `${this.id}-accuracy`,
        style: { 'fill-color': '#1a73e8', 'fill-opacity': 0.2, 'fill-outline-color': '#1a73e8' },
      }),
    );
    const point = layers.stack.add(
      pointLayer({
        id: `${this.id}-position`,
        style: {
          'circle-color': '#1a73e8',
          'circle-radius': 7,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      }),
    );
    this.#marker = { point, circle };
    return this.#marker;
  }

  #removeMarker(): void {
    const marker = this.#marker;
    this.#marker = undefined;
    if (marker === undefined || this.#context === undefined) return;
    void this.#context.layers().then((layers) => {
      layers.stack.remove(marker.point);
      layers.stack.remove(marker.circle);
    });
  }

  #setState(state: Status): void {
    this.#state = state;
    const context = this.#context;
    if (context === undefined || this.#button === undefined || this.#status === undefined) return;
    const { i18n } = context;
    this.#button.setAttribute('aria-pressed', String(this.active));
    label(this.#button, i18n.t(this.active ? 'geolocate.stop' : 'geolocate.show'));
    this.#status.dataset['state'] = state;
    this.#status.textContent =
      state === 'locating'
        ? i18n.t('geolocate.locating')
        : state === 'found'
          ? i18n.t('geolocate.found', { accuracy: formatLength(this.#accuracyMeters, i18n.language) })
          : state === 'denied'
            ? i18n.t('geolocate.denied')
            : state === 'unavailable'
              ? i18n.t('geolocate.unavailable')
              : '';
  }
}
