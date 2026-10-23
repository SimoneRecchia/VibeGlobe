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
