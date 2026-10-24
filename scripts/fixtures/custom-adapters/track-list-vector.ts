// A consumer's own vector adapter for an unusual text format, the "track list" of a fixture logger service: one
// record per line, `point <name> <lat>,<lon>[,<height>]` or `track <name> <lat>,<lon> <lat>,<lon> ...`, latitude
// first. It parses to the engine's vector features (`@vibeglobe/sources/vector`), never throws, and reports bad
// records as issues (F219). Public engine API only.
import type { FeatureIssue, ParsedFeatures, Position, VectorFeature } from '@vibeglobe/sources/vector';

/** Most records parsed from one document: a bound on untrusted input. */
const MAX_RECORDS = 100_000;

/** `<lat>,<lon>[,<height>]` as a position (longitude first), or undefined when malformed or out of range. */
function position(text: string): Position | undefined {
  const parts = text.split(',').map(Number);
  const [lat, lon, height] = parts;
  if (parts.length < 2 || parts.length > 3 || lat === undefined || lon === undefined) return undefined;
  if (!parts.every((v) => Number.isFinite(v)) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return height === undefined ? [lon, lat] : [lon, lat, height];
}

function record(line: string): VectorFeature | string {
  const [kind, name, ...points] = line.trim().split(/\s+/);
  const positions = points.map(position);
  if (name === undefined || positions.some((p) => p === undefined)) return 'malformed coordinates';
  const coordinates = positions.filter((p): p is Position => p !== undefined);
  const first = coordinates[0];
  if (kind === 'point' && coordinates.length === 1 && first)
    return { id: name, geometry: { type: 'Point', coordinates: first }, properties: { name } };
  if (kind === 'track' && coordinates.length >= 2)
    return { id: name, geometry: { type: 'LineString', coordinates }, properties: { name } };
  return `unknown record "${kind ?? ''}" or wrong number of positions`;
}

/** Parses a track list document. */
export function parseTrackList(input: string | Uint8Array): ParsedFeatures {
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
  const features: VectorFeature[] = [];
  const issues: FeatureIssue[] = [];
  const lines = text.split('\n').filter((line) => line.trim().length > 0 && !line.startsWith('#'));
  if (lines.length > MAX_RECORDS) return { features, issues: [{ index: -1, message: 'too many records' }] };
  lines.forEach((line, index) => {
    const parsed = record(line);
    if (typeof parsed === 'string') issues.push({ index, message: parsed });
    else features.push(parsed);
  });
  return { features, issues };
}
