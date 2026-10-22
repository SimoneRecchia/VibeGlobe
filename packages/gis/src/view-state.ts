/**
 * The camera state as text: a URL fragment parameter and JSON, exact to the last bit (numbers are written in their
 * shortest round-trip form). Malformed input is rejected; out-of-range values are clamped or wrapped.
 */

/**
 * View modes of the engine (PLAN.md: Auto follows the zoom-driven curves, 2D locks the tilt at 0°, 3D uses the default
 * tilt). A stub until the engine exposes them (F161, F163; docs/parallel-tracks.md).
 */
export type ViewMode = 'auto' | '2d' | '3d';

/** A serializable camera: the chosen values of the view and its mode. */
export interface ViewState {
  readonly longitudeDeg: number;
  readonly latitudeDeg: number;
  /** Web Mercator zoom, continuous. */
  readonly zoom: number;
  readonly headingDeg: number;
  /** The applied tilt. */
  readonly tiltDeg: number;
  /** The chosen view mode. */
  readonly viewMode: ViewMode;
  /** The tilt the user chose by hand, which persists across zoom (F215); undefined when none was chosen. */
  readonly chosenTiltDeg?: number;
}

const VIEW_MODES: readonly ViewMode[] = ['auto', '2d', '3d'];
/** The engine's accepted ranges (core's view validation). */
const MIN_ZOOM = -2;
const MAX_ZOOM = 28;
const MAX_TILT_DEG = 89;
const FORMAT_VERSION = 1;

/** Clamps to [min, max]; `+ 0` turns -0 into 0, which JSON cannot write anyway. */
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value)) + 0;

/** Wraps into [min, min + period), returning values already inside unchanged (arithmetic would round them). */
function wrap(value: number, min: number, period: number): number {
  if (value >= min && value < min + period) return value + 0;
  const wrapped = ((((value - min) % period) + period) % period) + min;
  return wrapped >= min + period ? min : wrapped;
}

/** Normalizes a view: longitude to [-180, 180), heading to [0, 360), the rest clamped to the engine's ranges. */
function normalize(view: ViewState): ViewState {
  const normalized = {
    longitudeDeg: wrap(view.longitudeDeg, -180, 360),
    latitudeDeg: clamp(view.latitudeDeg, -90, 90),
    zoom: clamp(view.zoom, MIN_ZOOM, MAX_ZOOM),
    headingDeg: wrap(view.headingDeg, 0, 360),
    tiltDeg: clamp(view.tiltDeg, 0, MAX_TILT_DEG),
    viewMode: view.viewMode,
  };
  return view.chosenTiltDeg === undefined
    ? normalized
    : { ...normalized, chosenTiltDeg: clamp(view.chosenTiltDeg, 0, MAX_TILT_DEG) };
}

/** Builds a view from untrusted fields, or undefined when one is missing, not finite or of the wrong type. */
function fromFields(fields: Readonly<Record<string, unknown>>): ViewState | undefined {
  const numbers = ['longitudeDeg', 'latitudeDeg', 'zoom', 'headingDeg', 'tiltDeg'] as const;
  for (const name of numbers) {
    const value = fields[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  }
  const mode = fields['viewMode'];
  const chosen = fields['chosenTiltDeg'];
  if (!VIEW_MODES.includes(mode as ViewMode)) return undefined;
  if (chosen !== undefined && (typeof chosen !== 'number' || !Number.isFinite(chosen))) return undefined;
  const view = {
    longitudeDeg: fields['longitudeDeg'] as number,
    latitudeDeg: fields['latitudeDeg'] as number,
    zoom: fields['zoom'] as number,
    headingDeg: fields['headingDeg'] as number,
    tiltDeg: fields['tiltDeg'] as number,
    viewMode: mode as ViewMode,
  };
  return normalize(chosen === undefined ? view : { ...view, chosenTiltDeg: chosen });
}

/** The view as JSON text: `{"version":1,"longitudeDeg":…}`. */
export function viewStateToJson(view: ViewState): string {
  return JSON.stringify({ version: FORMAT_VERSION, ...normalize(view) });
}

/**
 * Reads a view written by {@link viewStateToJson}, or returns undefined for malformed JSON, another version, or a
 * missing, non-numeric or non-finite field. Out-of-range values are clamped (latitude, zoom, tilt) or wrapped
 * (longitude, heading).
 */
export function viewStateFromJson(json: string): ViewState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const fields = parsed as Record<string, unknown>;
  return fields['version'] === FORMAT_VERSION ? fromFields(fields) : undefined;
}

/** Name of the URL fragment parameter that holds the view. */
export const VIEW_URL_PARAMETER = 'view';

/**
 * The view as a URL fragment parameter value: `zoom/latitude/longitude/heading/tilt/mode[/chosenTilt]`, numbers in
 * their shortest round-trip form so the view restores exactly. Put it in a URL with {@link viewStateToUrl}.
 */
export function viewStateToFragment(view: ViewState): string {
  const v = normalize(view);
  const parts = [v.zoom, v.latitudeDeg, v.longitudeDeg, v.headingDeg, v.tiltDeg, v.viewMode];
  if (v.chosenTiltDeg !== undefined) parts.push(v.chosenTiltDeg);
  return parts.map(String).join('/');
}

/** Reads a fragment parameter value written by {@link viewStateToFragment}; undefined when malformed. */
export function viewStateFromFragment(value: string): ViewState | undefined {
  const parts = value.split('/');
  if (parts.length !== 6 && parts.length !== 7) return undefined;
  const number = (text: string | undefined): number =>
    text !== undefined && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text) ? Number(text) : NaN;
  const [zoom, latitude, longitude, heading, tilt, mode, chosen] = parts;
  return fromFields({
    zoom: number(zoom),
    latitudeDeg: number(latitude),
    longitudeDeg: number(longitude),
    headingDeg: number(heading),
    tiltDeg: number(tilt),
    viewMode: mode,
    ...(chosen === undefined ? {} : { chosenTiltDeg: number(chosen) }),
  });
}

/**
 * Returns `url` with the view in its fragment (`#view=…`), keeping the fragment's other parameters.
 *
 * @param url - Any absolute URL, for example `location.href`.
 * @param view - The view to store.
 */
export function viewStateToUrl(url: string, view: ViewState): string {
  const target = new URL(url);
  const params = new URLSearchParams(target.hash.slice(1));
  params.set(VIEW_URL_PARAMETER, viewStateToFragment(view));
  target.hash = params.toString().replaceAll('%2F', '/');
  return target.href;
}

/** The view stored in a URL's fragment by {@link viewStateToUrl}, or undefined when absent or malformed. */
export function viewStateFromUrl(url: string): ViewState | undefined {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  const value = new URLSearchParams(target.hash.slice(1)).get(VIEW_URL_PARAMETER);
  return value === null ? undefined : viewStateFromFragment(value);
}
