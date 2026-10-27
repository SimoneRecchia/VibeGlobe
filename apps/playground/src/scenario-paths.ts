// Frame-stepped scenario paths (M5): the views a scenario moves through, frame by frame.
import type { ViewInit } from '@vibeglobe/core';

/** A frame-stepped scenario: how many frames, and the view of each (undefined: the camera holds still). */
export interface FrameScenario {
  readonly frames: number;
  view(frame: number): ViewInit | undefined;
  /** Measure, in every frame, how far the terrain rises above the ellipsoid's horizon (F142). */
  readonly relief?: boolean;
  /** Record the camera state of every frame: zoom, morph and relief factors, applied tilt (M5). */
  readonly samples?: boolean;
}

/** Each segment of a scenario: `motion` frames moving from one view to the next, then `hold` frames still. */
export function segments(views: readonly ViewInit[], motion: number, hold: number): FrameScenario {
  const step = motion + hold;
  return {
    frames: (views.length - 1) * step + hold,
    view(frame) {
      const segment = Math.floor(frame / step);
      const into = frame - segment * step;
      const from = views[segment];
      const to = views[segment + 1];
      if (!from || !to || into >= motion) return frame === 0 ? views[0] : undefined;
      const t = (into + 1) / motion;
      const mixed: Record<string, number> = {};
      // Only the fields both views give: a view without a tilt leaves the view mode's tilt (M5).
      for (const key of ['longitudeDeg', 'latitudeDeg', 'zoom', 'headingDeg', 'tiltDeg'] as const) {
        const a = (from as Record<string, number | undefined>)[key];
        const b = (to as Record<string, number | undefined>)[key];
        if (a !== undefined && b !== undefined) mixed[key] = a + (b - a) * t;
      }
      return mixed as ViewInit;
    },
  };
}
