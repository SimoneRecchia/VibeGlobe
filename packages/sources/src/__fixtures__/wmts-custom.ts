// A WMTS service with a custom tile matrix set in EPSG:25832 (ETRS89 / UTM zone 32N) for F228: a top-left origin
// that is not the system's, scale denominators in non-power-of-two ratios (2.5 and 3), matrices that cover only
// northern and central Italy, and 512-pixel tiles. The capabilities document and each tile's box in meters.

/** One matrix of the set. */
export interface CustomMatrix {
  readonly id: string;
  readonly scaleDenominator: number;
  readonly matrixWidth: number;
  readonly matrixHeight: number;
}

/** The set's origin (easting, northing), meters. */
export const ORIGIN: readonly [number, number] = [200_000, 5_300_000];
/** The tile size, pixels. */
export const TILE_PX = 512;
/** The size of a pixel at scale 1:1 (OGC's standardized rendering pixel), meters. */
const PIXEL_M = 0.00028;

/** Coarsest first; consecutive ratios 2.5, 2.5, 3, 2.5. */
export const MATRICES: readonly CustomMatrix[] = [
  { id: 'L0', scaleDenominator: 3_000_000, matrixWidth: 2, matrixHeight: 3 },
  { id: 'L1', scaleDenominator: 1_200_000, matrixWidth: 5, matrixHeight: 6 },
  { id: 'L2', scaleDenominator: 480_000, matrixWidth: 11, matrixHeight: 15 },
  { id: 'L3', scaleDenominator: 160_000, matrixWidth: 31, matrixHeight: 44 },
  { id: 'L4', scaleDenominator: 64_000, matrixWidth: 77, matrixHeight: 110 },
];

/** The span of one tile of a matrix, meters. */
export function tileSpanM(matrix: CustomMatrix): number {
  return matrix.scaleDenominator * PIXEL_M * TILE_PX;
}

/** A tile's box in meters (minx, miny, maxx, maxy), or undefined outside the matrix. */
export function tileBox(matrixId: string, row: number, col: number): [number, number, number, number] | undefined {
  const matrix = MATRICES.find((m) => m.id === matrixId);
  if (!matrix || row < 0 || col < 0 || row >= matrix.matrixHeight || col >= matrix.matrixWidth) return undefined;
  const span = tileSpanM(matrix);
  const minX = ORIGIN[0] + col * span;
  const maxY = ORIGIN[1] - row * span;
  return [minX, maxY - span, minX + span, maxY];
}

/** The capabilities document; tiles at `{base}{TileMatrix}/{TileRow}/{TileCol}.png`. */
export function customCapabilities(base: string): string {
  const matrices = MATRICES.map(
    (m) =>
      `<TileMatrix><ows:Identifier>${m.id}</ows:Identifier><ScaleDenominator>${String(m.scaleDenominator)}</ScaleDenominator>` +
      `<TopLeftCorner>${String(ORIGIN[0])} ${String(ORIGIN[1])}</TopLeftCorner><TileWidth>${String(TILE_PX)}</TileWidth>` +
      `<TileHeight>${String(TILE_PX)}</TileHeight><MatrixWidth>${String(m.matrixWidth)}</MatrixWidth>` +
      `<MatrixHeight>${String(m.matrixHeight)}</MatrixHeight></TileMatrix>`,
  ).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">' +
    '<ows:ServiceIdentification><ows:Title>Custom matrix set</ows:Title></ows:ServiceIdentification>' +
    '<Contents><Layer><ows:Title>Ortho 25832</ows:Title><ows:Identifier>ortho25832</ows:Identifier>' +
    '<Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style><Format>image/png</Format>' +
    '<TileMatrixSetLink><TileMatrixSet>etrs89-utm32-custom</TileMatrixSet></TileMatrixSetLink>' +
    `<ResourceURL format="image/png" resourceType="tile" template="${base}{TileMatrix}/{TileRow}/{TileCol}.png"/>` +
    '</Layer><TileMatrixSet><ows:Identifier>etrs89-utm32-custom</ows:Identifier>' +
    `<ows:SupportedCRS>urn:ogc:def:crs:EPSG::25832</ows:SupportedCRS>${matrices}</TileMatrixSet></Contents></Capabilities>`
  );
}
