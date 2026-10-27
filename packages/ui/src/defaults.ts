// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The ready-made set of controls. */
import { CompassControl } from './controls/compass.js';
import { CoordinateReadoutControl } from './controls/readout.js';
import { DebugToggleControl } from './controls/debug-toggle.js';
import { FullscreenControl } from './controls/fullscreen.js';
import { SearchControl, type Geocoder } from './controls/search.js';
import { ZoomControl } from './controls/zoom.js';
import { AttributionControl } from './controls/attribution.js';
import { GeolocationControl } from './controls/geolocation.js';
import { HomeControl } from './controls/home.js';
import { LayerSwitcherControl, type LayerSwitcherOptions } from './controls/layer-switcher.js';
import { ScaleBarControl } from './controls/scale-bar.js';
import { TiltControl } from './controls/tilt.js';
import { ViewModeControl, type ViewModeControlOptions } from './controls/view-mode.js';
import type { Ui } from './ui.js';

/** Options of {@link addDefaultControls}. */
export interface DefaultControlsOptions {
  /** Adds the debug panel toggle (default false: absent unless enabled). */
  readonly debug?: boolean;
  /** The search box's place provider; without one it accepts coordinates only. */
  readonly geocoder?: Geocoder;
  /** The layer switcher's overlays, names and data layers. */
  readonly layers?: LayerSwitcherOptions;
  /** Whether the camera may tilt now (F625): the 2D / 3D / Auto toggle disables 3D while it says no. */
  readonly tilt?: ViewModeControlOptions['tilt'];
}

/**
 * Adds the basic built-in controls in their default corners: search (top left); zoom, compass and fullscreen (top
 * right); coordinates readout and, when enabled, the debug toggle (bottom left). Each can then be removed or replaced by
 * id. {@link addAllControls} adds every navigation control.
 */
export function addDefaultControls(ui: Ui, options: DefaultControlsOptions = {}): void {
  ui.add(new SearchControl(options.geocoder === undefined ? {} : { geocoder: options.geocoder }));
  ui.add(new ZoomControl());
  ui.add(new CompassControl());
  ui.add(new FullscreenControl());
  ui.add(new CoordinateReadoutControl());
  if (options.debug === true) ui.add(new DebugToggleControl());
}

/**
 * Adds every built-in navigation control in its default corner: search and the 2D / 3D / Auto toggle (top left); zoom,
 * compass, tilt, reset-to-globe and home, geolocation, layers and fullscreen (top right); coordinates readout, scale
 * bar and, when enabled, the debug toggle (bottom left); attribution (bottom right). Each can then be removed or
 * replaced by id. The tools (drawing, measurement, bookmarks, screenshot, minimap) are added one by one.
 */
export function addAllControls(ui: Ui, options: DefaultControlsOptions = {}): void {
  ui.add(new SearchControl(options.geocoder === undefined ? {} : { geocoder: options.geocoder }));
  ui.add(new ViewModeControl({ position: 'top-left', ...(options.tilt ? { tilt: options.tilt } : {}) }));
  ui.add(new ZoomControl());
  ui.add(new CompassControl());
  ui.add(new TiltControl());
  ui.add(new HomeControl());
  ui.add(new GeolocationControl());
  ui.add(new LayerSwitcherControl(options.layers));
  ui.add(new FullscreenControl());
  ui.add(new CoordinateReadoutControl());
  ui.add(new ScaleBarControl());
  if (options.debug === true) ui.add(new DebugToggleControl());
  ui.add(new AttributionControl());
}
