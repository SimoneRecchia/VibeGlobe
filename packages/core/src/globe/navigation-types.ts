// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** How drags move the camera, set by the controls on the `NavigationApi` (F620, F623). */
export interface NavigationModeSettings {
  /**
   * How a drag moves the camera: 'free' (the default) turns the globe as a trackball, so the grabbed point stays under
   * the cursor over the poles and the heading turns with it; 'north-up' holds the heading, horizontal drags turning
   * about the polar axis and vertical ones changing latitude up to {@link NavigationModeSettings.northUpMaxLatitudeDeg}. Any other value acts
   * as 'free'.
   */
  navigationMode?: 'free' | 'north-up';
  /**
   * The highest latitude, degrees, of the point a 'north-up' camera looks at (default 85; above 0 and below 90, the
   * controls validate it): drags and zooms stop there, short of the pole, where the view would spin about it.
   */
  northUpMaxLatitudeDeg?: number;
}
