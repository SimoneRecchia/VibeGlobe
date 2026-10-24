// Scenarios of the milestone acceptances that need their own stack or terrain (F167, F269).
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
      { longitudeDeg: 7.5, latitudeDeg: 45.5, zoom: 9 },
      { longitudeDeg: 13, latitudeDeg: 43, zoom: 9 },
      { ...ROME, zoom: 9 },
      { ...ROME, zoom: 13 },
      // Out like a flight: up first, across at a low zoom, then down a little.
      { ...ROME, zoom: 6 },
      { longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 6 },
      { longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 5 },
    ],
    90,
    2,
  ),
};
