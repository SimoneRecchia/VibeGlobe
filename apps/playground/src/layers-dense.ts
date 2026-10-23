import { LabelLayer, type Feature } from '@vibeglobe/layers';

/** Colors of the five priorities, 0 (highest, placed first) to 4. */
const RANK_COLORS = ['#ff3030', '#ffa020', '#ffff40', '#40ff60', '#40c0ff'];

/**
 * `?scenario=data-labels-dense` (F359, F360): 10,000 labels in a 100 × 100 grid 0.02° apart around Rome, of five
 * priorities (`symbol-sort-key`: the lower, the earlier placed), decluttered by collision. A label's id `r<rank>-<i>`
 * carries its priority.
 */
export function denseLabels(): LabelLayer {
  const data: Feature[] = [];
  for (let i = 0; i < 10_000; i++) {
    const rank = (i * 7919) % 5;
    data.push({
      type: 'Feature',
      id: `r${String(rank)}-${String(i)}`,
      properties: { rank, name: `${String(rank)}·${String(i)}` },
      geometry: { type: 'Point', coordinates: [11.5 + (i % 100) * 0.02, 40.9 + Math.floor(i / 100) * 0.02] },
    });
  }
  return new LabelLayer({
    id: 'dense',
    data,
    style: {
      'text-field': ['get', 'name'],
      'text-size': 12,
      'text-color': [
        'match',
        ['get', 'rank'],
        0,
        RANK_COLORS[0],
        1,
        RANK_COLORS[1],
        2,
        RANK_COLORS[2],
        3,
        RANK_COLORS[3],
        RANK_COLORS[4],
      ],
      'text-halo-width': 0,
      'symbol-sort-key': ['get', 'rank'],
    },
  });
}
