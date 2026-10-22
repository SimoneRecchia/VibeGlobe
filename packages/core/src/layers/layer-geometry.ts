import { geodeticToEcef } from '../geodesy/ecef.js';
import { planeCenterOf, writeNormal, writePlane } from '../surface/surface-mesh.js';
import type { LayerRenderTarget } from './layer-target.js';

const RAD = Math.PI / 180;
const vertex = new Float64Array(3);

/** Where a layer batch's vertices are measured from (ADR 0037): an ECEF origin and a plane center, both float64. */
export interface LayerOrigin {
  readonly originEcef: Float64Array;
  readonly planeCenter: Float64Array;
}

/** The origin of a batch whose features lie around a position (degrees): the surface's precision path (ADR 0004). */
export function layerOrigin(longitudeDeg: number, latitudeDeg: number): LayerOrigin {
  const originEcef = new Float64Array(3);
  geodeticToEcef(longitudeDeg * RAD, latitudeDeg * RAD, 0, originEcef);
  return { originEcef, planeCenter: planeCenterOf(longitudeDeg * RAD, latitudeDeg * RAD) };
}

/** Vertex attributes of layer geometry, the surface tile's layout (`TileMeshData`): offsets, normals and planes. */
export interface LayerVertices {
  /** Offsets of the ground point (height 0) from the origin, xyz, meters. */
  readonly positions: Float32Array;
  /** Unit ellipsoid normals, xyz, along which heights raise the vertex. */
  readonly normals: Float32Array;
  /** Mercator offsets from the plane center, a 0 drop and the Mercator scale k(φ), four per vertex (ADR 0008). */
  readonly planes: Float32Array;
}

/**
 * Writes vertex `index` of a layer mesh at a position in degrees: the same attributes a surface tile vertex carries, so
 * the renderer places it between the globe and the flat map with the surface's precision (ADR 0037).
 */
export function writeLayerVertex(
  out: LayerVertices,
  index: number,
  longitudeDeg: number,
  latitudeDeg: number,
  origin: LayerOrigin,
): void {
  const lonRad = longitudeDeg * RAD;
  const latRad = latitudeDeg * RAD;
  geodeticToEcef(lonRad, latRad, 0, vertex);
  for (let i = 0; i < 3; i++) out.positions[index * 3 + i] = (vertex[i] ?? 0) - (origin.originEcef[i] ?? 0);
  writeNormal(out.normals, index, lonRad, latRad);
  writePlane(out.planes, index, lonRad, latRad, 0, origin.planeCenter);
}

/** A layer target whose every call also asks for a frame, so a change shows on the next frame (ADR 0037). */
export function requestingTarget(
  target: LayerRenderTarget | undefined,
  requestRender: () => void,
): LayerRenderTarget | undefined {
  if (!target) return undefined;
  const after =
    <A extends unknown[], R>(call: (...args: A) => R) =>
    (...args: A): R => {
      const result = call(...args);
      requestRender();
      return result;
    };
  return {
    createBatch: after((descriptor) => target.createBatch(descriptor)),
    growBatch: after((handle, capacity) => target.growBatch(handle, capacity)),
    writeRange: after((handle, attribute, first, count, data) =>
      target.writeRange(handle, attribute, first, count, data),
    ),
    writeStrings: after((handle, channel, first, count, values) =>
      target.writeStrings(handle, channel, first, count, values),
    ),
    writeGeometry: after((handle, feature, geometry) => target.writeGeometry(handle, feature, geometry)),
    setUniform: after((handle, attribute, value) => target.setUniform(handle, attribute, value)),
    setCount: after((handle, count) => target.setCount(handle, count)),
    setOrder: after((handle, order) => target.setOrder(handle, order)),
    setVisible: after((handle, visible) => target.setVisible(handle, visible)),
    release: after((handle) => target.release(handle)),
  };
}
