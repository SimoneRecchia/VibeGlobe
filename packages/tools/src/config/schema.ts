/**
 * Versioned build configuration files (ADR 0023): every build is defined only by one of these JSON files, so a new
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
  /** Dataset release the bucket serves (pinned for reproducibility). */
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
export type SourceConfig = CopernicusDemSource | S2CloudlessSource | GeoTiffSource | OsmExtractSource | XyzSource;

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
