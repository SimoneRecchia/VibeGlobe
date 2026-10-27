// Scenarios of the milestone acceptances and checks that need their own stack, terrain or path (F167, F269, F395).
import { segments, type FrameScenario } from './scenario-paths.js';

const ROME = { longitudeDeg: 12.5, latitudeDeg: 41.9 };
/** On the fixture peak's southern flank (scripts/fixtures/tiles/terrain.ts), 8 km from its summit, facing it. */
const FLANK = { longitudeDeg: 6.86, latitudeDeg: 45.76 };

/** The acceptance scenarios, by name. */
export const ACCEPTANCE_SCENARIOS: Record<string, FrameScenario> = {
  // The same zoom down onto the fixture relief, with `?terrain=terrarium` (the M5 acceptance with terrain, F167).
  'zoom-globe-to-street-relief': {
    ...segments(
      [
        { ...FLANK, zoom: 1 },
        { ...FLANK, zoom: 18 },
      ],
      170,
      2,
    ),
    samples: true,
  },
  // M7 acceptance (F269): across every boundary of a mixed stack (e2e/sources-mixed-stack.spec.ts adds its package base
  // and WMS overlay): down over the French-Italian border, east across 12° E where the UTM zone ends, into Rome, and
  // out again toward Paris. Pans run at a fixed zoom, a fraction of the view per frame, so a frame that changes much is
  // a source switching, not the motion.
  'mixed-stack': segments(
    [
      { longitudeDeg: 4, latitudeDeg: 46, zoom: 3 },
      // The pan at zoom 7 (5 px a frame): across the terrain box's and the UTM raster's edges.
      { longitudeDeg: 7.5, latitudeDeg: 45.5, zoom: 7 },
      { longitudeDeg: 13, latitudeDeg: 43, zoom: 7 },
      { ...ROME, zoom: 7 },
      { ...ROME, zoom: 13 },
      // Out like a flight: up first, across at a low zoom, then down a little.
      { ...ROME, zoom: 6 },
      { longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 6 },
      { longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 5 },
    ],
    90,
    2,
  ),
  // F395: a low tilted flight toward the horizon, the distance fogged: east along the Po valley, turning, at 85° tilt.
  'tilted-flight': segments(
    [
      { longitudeDeg: 8, latitudeDeg: 45, zoom: 12, tiltDeg: 85, headingDeg: 60 },
      { longitudeDeg: 8.3, latitudeDeg: 45.1, zoom: 12.5, tiltDeg: 85, headingDeg: 90 },
      { longitudeDeg: 8.6, latitudeDeg: 45.05, zoom: 12, tiltDeg: 85, headingDeg: 120 },
    ],
    90,
    10,
  ),
};
