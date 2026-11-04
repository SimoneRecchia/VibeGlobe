// A consumer application that installs only `vibeglobe` and starts the globe in one call with its own tiles (F702).
import { createVibeGlobe, type Globe } from 'vibeglobe';
import { xyzImagery } from 'vibeglobe/sources';

declare global {
  interface Window {
    /** The globe, for the release checks (scripts/release/check-consumers.ts). */
    minimalGlobe?: Globe;
  }
}

const container = document.querySelector<HTMLDivElement>('#map');
if (!container) throw new Error('#map is missing');
const { globe } = await createVibeGlobe(container, {
  tiles: {
    imagery: [
      xyzImagery({
        id: 'imagery',
        url: `${location.origin}/fixture-tiles/release/world/mercator/{z}/{x}/{y}.etc1s.ktx2`,
        decoder: 'ktx2',
        maxLevel: 6,
      }),
    ],
  },
  baseImageryUrl: '/natural-earth-4096.jpg',
  ui: false,
  view: { longitudeDeg: 12.5, latitudeDeg: 42, zoom: 4 },
});
window.minimalGlobe = globe;
