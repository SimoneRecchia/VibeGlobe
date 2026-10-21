/** The ready-made set of controls. */
import { CompassControl } from './controls/compass.js';
import { CoordinateReadoutControl } from './controls/readout.js';
import { DebugToggleControl } from './controls/debug-toggle.js';
import { FullscreenControl } from './controls/fullscreen.js';
import { SearchControl, type Geocoder } from './controls/search.js';
import { ZoomControl } from './controls/zoom.js';
import type { Ui } from './ui.js';

/** Options of {@link addDefaultControls}. */
export interface DefaultControlsOptions {
  /** Adds the debug panel toggle (default false: absent unless enabled). */
  readonly debug?: boolean;
  /** The search box's place provider; without one it accepts coordinates only. */
  readonly geocoder?: Geocoder;
}

/**
 * Adds every built-in control in its default corner: search (top left); zoom, compass and fullscreen (top right);
 * coordinates readout and, when enabled, the debug toggle (bottom left). Each can then be removed or replaced by id.
 */
export function addDefaultControls(ui: Ui, options: DefaultControlsOptions = {}): void {
  ui.add(new SearchControl(options.geocoder === undefined ? {} : { geocoder: options.geocoder }));
  ui.add(new ZoomControl());
  ui.add(new CompassControl());
  ui.add(new FullscreenControl());
  ui.add(new CoordinateReadoutControl());
  if (options.debug === true) ui.add(new DebugToggleControl());
}
