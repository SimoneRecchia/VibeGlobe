/**
 * Synthetic source data for sample builds without real downloads: the documented fixture stub of Sentinel-2 cloudless
 * originals (when the owner's requester-pays access is unavailable) and a small OpenStreetMap extract. Content is a
 * deterministic function of position, so tile seams and misplacements show.
 */
import { deflateSync } from 'node:zlib';
import { encodePng } from '../encode/png.js';
import { s2FileExtentDeg } from '../sources/files.js';
import { tileXToLon, tileYToLat } from '../tiles/mercator.js';
import { ProtoWriter } from '../vector/protobuf.js';

/** The synthetic imagery color at a position: smooth gradients with a 0.01° grid, never black. */
function syntheticColor(lon: number, lat: number): [number, number, number] {
  const grid = Math.abs(lon * 100 - Math.round(lon * 100)) < 0.03 || Math.abs(lat * 100 - Math.round(lat * 100)) < 0.03;
  if (grid) return [250, 250, 250];
  const r = 60 + Math.round(((lon + 180) * 37) % 160);
  const g = 60 + Math.round(((lat + 90) * 53) % 160);
  return [r, g, 40 + Math.round(((lon - lat) * 11 + 1000) % 120)];
}

/** RGB pixels of the synthetic imagery over a square whose north-west corner is at lon, lat. */
function syntheticPixels(west: number, north: number, extentDeg: number, size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 3);
  const step = extentDeg / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++)
      pixels.set(syntheticColor(west + (x + 0.5) * step, north - (y + 0.5) * step), (y * size + x) * 3);
  }
  return pixels;
}

/** An uncompressed RGB GeoTIFF (pixel-is-area, EPSG:4326) of `size` px whose north-west corner is at lon, lat. */
function syntheticGeoTiff(west: number, north: number, extentDeg: number, size: number): Uint8Array {
  const pixels = syntheticPixels(west, north, extentDeg, size);
  const step = extentDeg / size;
  const entries: [number, number, number[]][] = [
    [256, 3, [size]],
    [257, 3, [size]],
    [258, 3, [8, 8, 8]],
    [259, 3, [1]],
    [262, 3, [2]],
    [273, 4, [0]],
    [277, 3, [3]],
    [278, 3, [size]],
    [279, 4, [pixels.length]],
    [284, 3, [1]],
    [33550, 12, [step, step, 0]],
    [33922, 12, [0, 0, 0, west, north, 0]],
    [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]],
  ];
  const sizes: Record<number, number> = { 3: 2, 4: 4, 12: 8 };
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdSize;
  const blobs: [number, number[], number][] = [];
  const head = new DataView(new ArrayBuffer(8 + ifdSize));
  head.setUint16(0, 0x4949, false);
  head.setUint16(2, 42, true);
  head.setUint32(4, 8, true);
  head.setUint16(8, entries.length, true);
  const dataOffset =
    extra +
    entries.reduce((n, [, type, v]) => n + (v.length * (sizes[type] ?? 4) > 4 ? v.length * (sizes[type] ?? 4) : 0), 0);
  entries.forEach(([tag, type, values], i) => {
    const at = 10 + i * 12;
    const vals = tag === 273 ? [dataOffset] : values;
    head.setUint16(at, tag, true);
    head.setUint16(at + 2, type, true);
    head.setUint32(at + 4, vals.length, true);
    const bytes = vals.length * (sizes[type] ?? 4);
    if (bytes <= 4)
      vals.forEach((v, k) => (type === 3 ? head.setUint16(at + 8 + k * 2, v, true) : head.setUint32(at + 8, v, true)));
    else {
      head.setUint32(at + 8, extra, true);
      blobs.push([type, vals, extra]);
      extra += bytes;
    }
  });
  const out = new Uint8Array(dataOffset + pixels.length);
  out.set(new Uint8Array(head.buffer), 0);
  const view = new DataView(out.buffer);
  for (const [type, vals, at] of blobs) {
    vals.forEach((v, k) =>
      type === 12
        ? view.setFloat64(at + k * 8, v, true)
        : type === 3
          ? view.setUint16(at + k * 2, v, true)
          : view.setUint32(at + k * 4, v, true),
    );
  }
  out.set(pixels, dataOffset);
  return out;
}

/** The synthetic Sentinel-2 cloudless original file `tiles/{level}/{col}/{row}.tif` (512 px metatiles). */
export function syntheticS2File(level: number, col: number, row: number): Uint8Array {
  const extent = s2FileExtentDeg(level);
  return syntheticGeoTiff(col * extent - 180, 90 - row * extent, extent, 512);
}

/** A synthetic XYZ tile (PNG) for the package builder's fixture source. */
export function syntheticXyzTile(z: number, x: number, y: number): Uint8Array {
  const rgb = new Uint8Array(256 * 256 * 3);
  for (let py = 0; py < 256; py++) {
    const lat = tileYToLat(y + (py + 0.5) / 256, z);
    for (let px = 0; px < 256; px++)
      rgb.set(syntheticColor(tileXToLon(x + (px + 0.5) / 256, z), lat), (py * 256 + px) * 3);
  }
  return encodePng(rgb, 256, 256, 3);
}

/** One OSM element of the synthetic extract. */
interface Element {
  id: number;
  tags: Record<string, string>;
}

/** Writes an OSM PBF file with one data block: tagged nodes and ways (dense nodes, zlib blobs). */
export function writeOsmPbf(
  nodes: (Element & { lon: number; lat: number })[],
  ways: (Element & { refs: number[] })[],
): Uint8Array {
  const strings = [''];
  const index = (s: string): number => {
    const at = strings.indexOf(s);
    return at >= 0 ? at : strings.push(s) - 1;
  };
  const delta = (values: number[]): number[] => values.map((v, i) => v - (i > 0 ? (values[i - 1] ?? 0) : 0));
  const keysVals = nodes.flatMap((n) => [...Object.entries(n.tags).flatMap(([k, v]) => [index(k), index(v)]), 0]);
  const dense = new ProtoWriter()
    .packed(1, delta(nodes.map((n) => n.id)), true)
    .packed(8, delta(nodes.map((n) => Math.round(n.lat * 1e7))), true)
    .packed(9, delta(nodes.map((n) => Math.round(n.lon * 1e7))), true)
    .packed(10, keysVals, false);
  const group = new ProtoWriter().raw(2, dense.finish());
  const wayGroup = new ProtoWriter();
  for (const way of ways) {
    const entries = Object.entries(way.tags);
    const encoded = new ProtoWriter()
      .uint(1, way.id)
      .packed(
        2,
        entries.map(([k]) => index(k)),
        false,
      )
      .packed(
        3,
        entries.map(([, v]) => index(v)),
        false,
      )
      .packed(8, delta(way.refs), true);
    wayGroup.raw(3, encoded.finish());
  }
  const table = new ProtoWriter();
  for (const s of strings) table.raw(1, new TextEncoder().encode(s));
  const block = new ProtoWriter().raw(1, table.finish()).raw(2, group.finish()).raw(2, wayGroup.finish()).uint(17, 100);
  const blob = (type: string, data: Uint8Array): Uint8Array[] => {
    const body = new ProtoWriter().uint(2, data.length).raw(3, deflateSync(data)).finish();
    const header = new ProtoWriter().string(1, type).uint(3, body.length).finish();
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, header.length);
    return [length, header, body];
  };
  const osmHeader = new ProtoWriter().string(4, 'OsmSchema-V0.6').string(4, 'DenseNodes').finish();
  return Uint8Array.from(Buffer.concat([...blob('OSMHeader', osmHeader), ...blob('OSMData', block.finish())]));
}
