/** Restoring a serialized view (F414, F415) on a globe through its public API. */
import type { Globe } from '@vibeglobe/core';
import { normalizeViewState, type ViewState } from '@vibeglobe/gis';

/**
 * Restores a view on a globe through its public API: the view mode, then the position with the chosen tilt and
 * heading (a manual view chooses its tilt; Auto and 2D take theirs from the mode). `movement` 'jump' (default) moves in
 * one frame; 'fly' flies there (bookmarks, F415). Returns the movement.
 *
 * @param globe - The engine instance.
 * @param view - A view read by one of this module's functions or `viewStateOf` of `@vibeglobe/gis`.
 */
export function applyViewState(
  globe: Globe,
  view: ViewState,
  options: { readonly movement?: 'jump' | 'fly' } = {},
): ReturnType<Globe['jumpTo']> {
  const v = normalizeViewState(view);
  if (v.viewMode !== 'manual') globe.setViewMode(v.viewMode);
  const target = {
    longitudeDeg: v.longitudeDeg,
    latitudeDeg: v.latitudeDeg,
    zoom: v.zoom,
    headingDeg: v.chosenHeadingDeg ?? v.headingDeg,
    ...(v.viewMode === 'manual' ? { tiltDeg: v.chosenTiltDeg ?? v.tiltDeg } : {}),
  };
  return options.movement === 'fly' ? globe.flyTo(target) : globe.jumpTo(target);
}
