import { geodeticToEcef } from '../geodesy/ecef.js';
import { planeCenterOf, writeNormal, writePlane } from '../surface/surface-mesh.js';
import type { LayerRenderTarget } from './layer-target.js';
import type { ModelRenderer } from './models.js';
import type { FrameView } from '../globe/types.js';
import { morphPointInto } from '../view/morph.js';

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
    ...(target.pick ? { pick: target.pick.bind(target) } : {}),
    ...(target.stats ? { stats: target.stats.bind(target) } : {}),
    ...(target.addImage ? { addImage: after(target.addImage.bind(target)) } : {}),
    ...(target.models ? { models: requestingModels(target.models, after) } : {}),
  };
}

/** A model renderer whose changes each ask for a frame. */
function requestingModels(
  models: ModelRenderer,
  after: <A extends unknown[], R>(call: (...args: A) => R) => (...args: A) => R,
): ModelRenderer {
  return {
    load: after((source) => models.load(source)),
    setPose: after((id, pose) => models.setPose(id, pose)),
    remove: after((id) => models.remove(id)),
    ...(models.setPickId ? { setPickId: models.setPickId.bind(models) } : {}),
    ...(models.setHighlight ? { setHighlight: after(models.setHighlight.bind(models)) } : {}),
    ...(models.setVisible ? { setVisible: after(models.setVisible.bind(models)) } : {}),
  };
}

const geodetic = new Float64Array(3);
const morphed = new Float64Array(3);
const ground = new Float64Array(3);

/**
 * The screen position (CSS pixels, into `out[0..1]`) where a frame draws a layer position (degrees, meters), on the
 * morphed surface (ADR 0008); false behind the eye or, on the globe (m < ½), behind its horizon. For picking and tests
 * of layer drawing (ADR 0037). Allocates nothing.
 */
export function projectLayerPoint(
  view: FrameView,
  longitudeDeg: number,
  latitudeDeg: number,
  heightMeters: number,
  out: Float64Array,
): boolean {
  geodetic[0] = longitudeDeg * RAD;
  geodetic[1] = latitudeDeg * RAD;
  geodetic[2] = heightMeters;
  morphPointInto(view.morph, geodetic, morphed);
  const eye = view.eyeEcef;
  const x = (morphed[0] ?? 0) - (eye[0] ?? 0);
  const y = (morphed[1] ?? 0) - (eye[1] ?? 0);
  const z = (morphed[2] ?? 0) - (eye[2] ?? 0);
  if ((view.morph.factors[0] ?? 0) < 0.5) {
    geodeticToEcef(geodetic[0] ?? 0, geodetic[1] ?? 0, 0, ground);
    // The ellipsoid normal is close enough to the geocentric direction for this horizon test.
    const facing = (ground[0] ?? 0) * x + (ground[1] ?? 0) * y + (ground[2] ?? 0) * z;
    if (facing > 0) return false;
  }
  const v = view.view;
  const p = view.projection;
  const vx = (v[0] ?? 0) * x + (v[4] ?? 0) * y + (v[8] ?? 0) * z + (v[12] ?? 0);
  const vy = (v[1] ?? 0) * x + (v[5] ?? 0) * y + (v[9] ?? 0) * z + (v[13] ?? 0);
  const vz = (v[2] ?? 0) * x + (v[6] ?? 0) * y + (v[10] ?? 0) * z + (v[14] ?? 0);
  const vw = (v[3] ?? 0) * x + (v[7] ?? 0) * y + (v[11] ?? 0) * z + (v[15] ?? 1);
  const cx = (p[0] ?? 0) * vx + (p[4] ?? 0) * vy + (p[8] ?? 0) * vz + (p[12] ?? 0) * vw;
  const cy = (p[1] ?? 0) * vx + (p[5] ?? 0) * vy + (p[9] ?? 0) * vz + (p[13] ?? 0) * vw;
  const cw = (p[3] ?? 0) * vx + (p[7] ?? 0) * vy + (p[11] ?? 0) * vz + (p[15] ?? 0) * vw;
  if (!(cw > 0)) return false;
  out[0] = ((cx / cw + 1) / 2) * view.widthPx;
  out[1] = ((1 - cy / cw) / 2) * view.heightPx;
  return true;
}
