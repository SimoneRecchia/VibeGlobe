/**
 * Versioned build configuration files (ADR 0024): every build is defined only by one of these JSON files, so a new
 * region or dataset needs no code change.
 */
import type { Ring } from '../tiles/area.js';

/** An area in a configuration: a bounding box `[west, south, east, north]` or polygon rings. */
export interface AreaConfig {
  bbox?: [number, number, number, number];
  /** Rings of `[lonDeg, latDeg]`; or a path, relative to the configuration file, of a GeoJSON polygon. */
  polygon?: Ring[] | string;
}

/** The sample area: an area, and the lowest zoom a sample build makes (sample areas are aligned to its tiles). */
export interface SampleAreaConfig extends AreaConfig {
  minZoom?: number;
}

/** Copernicus DEM GLO-30 COGs, one per 1° cell, from the AWS Open Data bucket. */
export interface CopernicusDemSource {
  type: 'copernicus-dem';
  /** Bucket URL, `https://copernicus-dem-30m.s3.amazonaws.com`. */
  baseUrl: string;
  /**
   * Dataset release the bucket serves. The bucket holds only its current release, so the lock file's checksums pin
   * it: a newer release fails the download instead of changing the outputs.
   */
  release: string;
  /** Grid spacing: 1 arc second (GLO-30) or 3 arc seconds (GLO-90). */
  arcSeconds: 1 | 3;
}

/** Sentinel-2 cloudless original GeoTIFF tiles (EPSG:4326, 512 px, 2×2 metatiles per WMTS-simple level). */
export interface S2CloudlessSource {
  type: 's2cloudless';
  /** Bucket or mirror URL holding `tiles/{level}/{col}/{row}.tif`. */
  baseUrl: string;
  /** Mosaic edition (year); only 2016 is accepted (license gate). */
  edition: number;
  /** Source level to read, 7–13 (13 is about 10 m per pixel). */
  level: number;
  /** Whether the bucket is requester-pays (requests are then signed with the consumer's AWS credentials). */
  requesterPays: boolean;
}

/**
 * The ESA WorldCover Sentinel-2 RGBNIR yearly median composite (ADR 0026): one cloud-optimized GeoTIFF per 1° cell in
 * the public bucket `esa-worldcover-s2`, bands B04, B03, B02, B08 as uint16 reflectance × 10,000. Builds read only the
 * internal tiles of the chosen overview level that their area needs, with HTTP range requests.
 */
export interface WorldCoverSource {
  type: 'worldcover-s2';
  /** Bucket URL, `https://esa-worldcover-s2.s3.amazonaws.com`. */
  baseUrl: string;
  /** Composite year (2021). */
  year: number;
  /** Product version in the file names (`v200` for 2021). */
  version: string;
  /** Overview level read: 0 is the full 10 m grid, each level halves the resolution (4 is about 160 m). */
  overview: number;
  /**
   * Fills the composite's gaps (pixels never seen clear, mostly glaciers and high rock) by land-cover class from the
   * WorldCover map of the same year (ADR 0026); gaps on water, unlisted classes or outside the map keep the
   * colour stretch's `noDataReflectance`.
   */
  gapFill?: WorldCoverGapFill;
}

/** Land-cover-guided filling of WorldCover composite gaps. */
interface WorldCoverGapFill {
  /** Bucket URL of the land-cover maps, `https://esa-worldcover.s3.amazonaws.com`. */
  mapBaseUrl: string;
  /** Reflectance (× 10,000) of the red, green and blue bands for each WorldCover class code (`"70"` snow and ice). */
  classReflectance: Record<string, [number, number, number]>;
}

/** A single georeferenced raster in EPSG:4326, optionally inside a zip archive (Natural Earth). */
export interface GeoTiffSource {
  type: 'geotiff';
  url: string;
  /** File inside the zip archive at `url`. */
  member?: string;
}

/** An OpenStreetMap PBF extract from an extract provider. */
export interface OsmExtractSource {
  type: 'osm-extract';
  url: string;
}

/** Tiles of an existing XYZ tile source (offline package builder). */
export interface XyzSource {
  type: 'xyz';
  /** URL template with `{z}`, `{x}` and `{y}`. */
  url: string;
}

/** Any source a dataset can read. */
export type SourceConfig =
  CopernicusDemSource | S2CloudlessSource | WorldCoverSource | GeoTiffSource | OsmExtractSource | XyzSource;

/**
 * A fixed colour stretch from reflectance (× 10,000) to 8-bit RGB (ADR 0026):
 * `rgb = 255 × min(1, reflectance / maxReflectance) ^ (1 / gamma)`, the same for the three bands. Pixels without data
 * (WorldCover masks water) take `noDataReflectance`, so open water gets a constant, documented colour.
 */
interface ColorStretchConfig {
  maxReflectance: number;
  gamma: number;
  /** Reflectance (× 10,000) used for the red, green and blue bands where the source has no data. */
  noDataReflectance: [number, number, number];
}

/** Which outputs a dataset build writes. */
export interface OutputsConfig {
  static: boolean;
  pmtiles: boolean;
  mbtiles: boolean;
}

/** One dataset of a build. */
export interface DatasetConfig {
  id: string;
  kind: 'terrain' | 'imagery' | 'vector';
  /** Provider profile id (license/profiles.ts). */
  profile: string;
  /** Year the data represents, written into the attribution and metadata. */
  dataYear: number;
  /** Pinned source version (release, edition or extract date). */
  sourceVersion: string;
  source: SourceConfig;
  minZoom: number;
  maxZoom: number;
  /** Tile encoding: `terrarium` (terrain PNG), `png`, `jpeg` or `mvt`. */
  encoding: 'terrarium' | 'png' | 'jpeg' | 'mvt';
  /** JPEG quality, 1–100. */
  quality?: number;
  /** Colour stretch of reflectance sources (imagery only). */
  colorStretch?: ColorStretchConfig;
  /** Area override for this dataset; defaults to the build's region. */
  area?: AreaConfig;
  /** Average encoded tile size used by the estimate, in bytes, per zoom level or one value for all. */
  bytesPerTile: number | Record<string, number>;
  /** Average size of one downloaded source file, in bytes, used by the download and cost estimate. */
  downloadBytesPerFile: number;
  outputs: OutputsConfig;
  /**
   * A GDAL command run in the pinned image on each downloaded file before tiling, for inputs the built-in reader does
   * not handle (JPEG2000, other projections). `{input}` and `{output}` are replaced by paths inside the build folder;
   * the output must be a GeoTIFF in EPSG:4326, for example `["gdalwarp", "-t_srs", "EPSG:4326", "{input}", "{output}"]`.
   */
  convert?: string[];
  /** Also write the whole-world equirectangular image the engine pins as its base (imagery only). */
  baseImage?: { widthPx: number; quality: number };
}

/** Transfer and request prices used by the cost estimate, with their reading date. */
export interface PricesConfig {
  currency: string;
  readDate: string;
  sourceUrl: string;
  /** Price per GB downloaded from a requester-pays bucket (paid by the consumer). */
  requesterPaysTransferPerGB: number;
  /** Price per 1,000 GET requests on a requester-pays bucket. */
  requesterPaysGetPer1000: number;
  /** Price per GB from free sources (AWS Open Data, extract providers): normally 0. */
  freeTransferPerGB: number;
}

/** External tools, each a Docker image pinned by digest. */
export interface ToolsConfig {
  gdal: string;
}

/** A complete build configuration. */
export interface BuildConfig {
  configVersion: string;
  name: string;
  description: string;
  region: AreaConfig;
  /** Small area the configuration is verified on (`--sample`). */
  sampleArea: SampleAreaConfig;
  prices: PricesConfig;
  tools: ToolsConfig;
  datasets: DatasetConfig[];
}
