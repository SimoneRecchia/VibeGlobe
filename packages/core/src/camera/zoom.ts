import { WGS84 } from '../geodesy/wgs84.js';

/** Default vertical field of view, in radians (about 36.87°, a natural perspective that keeps the horizon calm). */
export const DEFAULT_FOV_Y_RAD = 0.6435011087932844;

const EQUATOR_METERS = 2 * Math.PI * WGS84.semiMajorAxisMeters;
const TILE_SIZE_PX = 512;

/**
 * Ground meters per CSS pixel at the screen center for a ground zoom z_g (ADR 0008): the whole equator spans 512 px at
 * z_g = 0 and each level halves the scale, the convention of the MapLibre Style Specification.
 */
export function groundMetersPerPixel(groundZoom: number): number {
  return EQUATOR_METERS / (TILE_SIZE_PX * 2 ** groundZoom);
}

/** The camera range (eye to target, in meters) that shows `groundZoom` at the screen center. */
export function rangeForGroundZoom(groundZoom: number, viewportHeightPx: number, fovYRad: number): number {
  return ((viewportHeightPx / 2) * groundMetersPerPixel(groundZoom)) / Math.tan(fovYRad / 2);
}

/** The ground zoom a camera range shows at the screen center; inverse of {@link rangeForGroundZoom}. */
export function groundZoomForRange(rangeMeters: number, viewportHeightPx: number, fovYRad: number): number {
  const metersPerPixel = (rangeMeters * Math.tan(fovYRad / 2)) / (viewportHeightPx / 2);
  return Math.log2(EQUATOR_METERS / (TILE_SIZE_PX * metersPerPixel));
}

/** Web Mercator zoom (the public `zoom`) from ground zoom at a latitude: zoom = z_g − log2 k(φ), k = 1 / cos φ. */
export function mercatorZoomFromGroundZoom(groundZoom: number, latitudeRad: number): number {
  return groundZoom + Math.log2(Math.max(Math.cos(latitudeRad), 1e-12));
}

/** Ground zoom from Web Mercator zoom at a latitude; inverse of {@link mercatorZoomFromGroundZoom}. */
export function groundZoomFromMercatorZoom(zoom: number, latitudeRad: number): number {
  return zoom - Math.log2(Math.max(Math.cos(latitudeRad), 1e-12));
}
