/**
 * The synthetic OpenStreetMap extract of the sample area (the Mont Blanc tile of zoom 10, astride the Italian–French
 * border): a town and a village with a street grid, a primary road crossing the border, and buildings with and
 * without height and level tags, plus a city and a motorway for low zooms. Invented data, not OpenStreetMap content.
 */
import { writeOsmPbf } from './synthetic.js';

type Node = { id: number; lon: number; lat: number; tags: Record<string, string> };
type Way = { id: number; tags: Record<string, string>; refs: number[] };

/** Builds the street grid and buildings of one settlement centred at lon, lat. */
function settlement(
  nodes: Node[],
  ways: Way[],
  lon: number,
  lat: number,
  name: string,
  place: string,
  firstId: number,
): void {
  let id = firstId;
  nodes.push({ id: id++, lon, lat, tags: { place, name, population: place === 'town' ? '2800' : '400' } });
  const step = 0.002;
  for (let k = -2; k <= 2; k++) {
    // East–west and north–south residential streets.
    const a = { id: id++, lon: lon - 2 * step, lat: lat + k * step, tags: {} };
    const b = { id: id++, lon: lon + 2 * step, lat: lat + k * step, tags: {} };
    const c = { id: id++, lon: lon + k * step, lat: lat - 2 * step, tags: {} };
    const d = { id: id++, lon: lon + k * step, lat: lat + 2 * step, tags: {} };
    nodes.push(a, b, c, d);
    ways.push({ id: id++, tags: { highway: 'residential', name: `Via ${name} ${k + 3}` }, refs: [a.id, b.id] });
    ways.push({ id: id++, tags: { highway: 'residential' }, refs: [c.id, d.id] });
  }
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const x = lon + (i - 1.5) * step;
      const y = lat + (j - 1.5) * step;
      const s = 0.0004;
      const corners = [
        [x - s, y - s],
        [x + s, y - s],
        [x + s, y + s],
        [x - s, y + s],
      ].map(([cx, cy]) => ({ id: id++, lon: cx ?? 0, lat: cy ?? 0, tags: {} }));
      nodes.push(...corners);
      const tags: Record<string, string> = { building: (i + j) % 2 ? 'house' : 'apartments' };
      if ((i + j) % 3 === 0) tags['height'] = `${6 + i * 3 + j}`;
      if ((i + j) % 2 === 0) tags['building:levels'] = `${2 + i}`;
      ways.push({ id: id++, tags, refs: [...corners.map((c) => c.id), corners[0]?.id ?? 0] });
    }
  }
}

/** The synthetic extract as PBF bytes. */
export function syntheticOsmExtract(): Uint8Array {
  const nodes: Node[] = [];
  const ways: Way[] = [];
  settlement(nodes, ways, 6.995, 45.865, 'Planpincieux', 'town', 1000);
  settlement(nodes, ways, 6.87, 45.95, 'Les Praz', 'village', 2000);
  // A primary road from Italy across the border into France.
  const road = [
    [7.02, 45.84],
    [6.995, 45.865],
    [6.95, 45.9],
    [6.87, 45.95],
    [6.7, 46.05],
  ].map(([lon, lat], i) => ({ id: 3000 + i, lon: lon ?? 0, lat: lat ?? 0, tags: {} }));
  nodes.push(...road);
  ways.push({
    id: 3100,
    tags: { highway: 'primary', ref: 'SS26', name: 'Strada del Monte Bianco' },
    refs: road.map((n) => n.id),
  });
  // A city and a motorway, which appear from zoom 4 and 5 (the world configuration's sample).
  nodes.push({ id: 4000, lon: 7.315, lat: 45.737, tags: { place: 'city', name: 'Aosta', population: '34000' } });
  const motorway = [
    [7.315, 45.73],
    [7.6, 45.6],
    [7.85, 45.45],
  ].map(([lon, lat], i) => ({ id: 4001 + i, lon: lon ?? 0, lat: lat ?? 0, tags: {} }));
  nodes.push(...motorway);
  ways.push({ id: 4100, tags: { highway: 'motorway', ref: 'A5' }, refs: motorway.map((n) => n.id) });
  nodes.sort((a, b) => a.id - b.id);
  return writeOsmPbf(nodes, ways);
}
