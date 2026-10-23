import { DataLayer, type Feature } from '@vibeglobe/layers';

/**
 * `?scenario=data-points-100k` (F376, F377): 99,900 points on a golden-angle spiral over the globe and the 10 × 10 grid
 * around Rome of `data-points` (ids `g0`–`g99`, 0.6° apart), 100,000 in all, colored and sized by their properties.
 */
export function manyPointsLayer(): DataLayer {
  const points: Feature[] = [];
  const red = '#ff2020';
  for (let i = 0; i < 100; i++)
    points.push({
      type: 'Feature',
      id: `g${String(i)}`,
      properties: { r: 4, c: red },
      geometry: { type: 'Point', coordinates: [9.8 + (i % 10) * 0.6, 39.2 + Math.floor(i / 10) * 0.6] },
    });
  const count = 99_900;
  for (let i = 0; i < count; i++) {
    const lat = (Math.asin(-1 + (2 * (i + 0.5)) / count) * 180) / Math.PI;
    const lon = ((((i * 137.50776405) % 360) + 540) % 360) - 180;
    points.push({
      type: 'Feature',
      id: `p${String(i)}`,
      properties: { r: 2, c: red },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    });
  }
  return new DataLayer('point', {
    id: 'points',
    data: points,
    style: { 'circle-color': ['get', 'c'], 'circle-radius': ['get', 'r'] },
  });
}

function grid(prefix: string, west: number, south: number, stepDeg: number, columns: number, rows: number): Feature[] {
  const features: Feature[] = [];
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++)
      features.push({
        type: 'Feature',
        id: `${prefix}${String(row * columns + column)}`,
        properties: {},
        geometry: { type: 'Point', coordinates: [west + column * stepDeg, south + row * stepDeg] },
      });
  return features;
}

/**
 * `?scenario=data-pick` (F384): points to pick in every phase. 6,000 on a golden-angle spiral over the globe (`w…`),
 * a 60 × 40 grid 0.05° apart around Rome for the 2D and tilted views at zoom 7 (`r…`), and a 40 × 40 grid 0.0001°
 * (about 10 m) apart in central Rome, small features for the street level (`s…`).
 */
export function pickLayers(): DataLayer[] {
  const world: Feature[] = [];
  for (let i = 0; i < 6000; i++) {
    const lat = (Math.asin(-1 + (2 * (i + 0.5)) / 6000) * 180) / Math.PI;
    const lon = ((((i * 137.50776405) % 360) + 540) % 360) - 180;
    world.push({
      type: 'Feature',
      id: `w${String(i)}`,
      properties: {},
      geometry: { type: 'Point', coordinates: [lon, lat] },
    });
  }
  const style = { 'circle-color': '#ff2020', 'circle-radius': 3 };
  return [
    new DataLayer('point', { id: 'pick-world', data: world, style }),
    new DataLayer('point', { id: 'pick-region', data: grid('r', 10.5, 40.9, 0.05, 60, 40), style }),
    new DataLayer('point', { id: 'pick-street', data: grid('s', 12.494, 41.9008, 0.0001, 40, 40), style }),
  ];
}
