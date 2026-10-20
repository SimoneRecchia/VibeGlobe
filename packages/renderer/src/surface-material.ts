import { positionLocal, texture, uniform, uv } from 'three/tsl';
import { DoubleSide, MeshBasicNodeMaterial, Vector3, type Object3D, type Texture } from 'three/webgpu';

/** Per-object data the surface material reads: the tile origin minus the eye, split into float32 high and low parts. */
export interface EyeOffset {
  readonly high: Vector3;
  readonly low: Vector3;
}

const offsets = new WeakMap<Object3D, EyeOffset>();

/** Attaches the eye-relative offset record to a mesh. */
export function attachEyeOffset(object: Object3D): EyeOffset {
  const offset = { high: new Vector3(), low: new Vector3() };
  offsets.set(object, offset);
  return offset;
}

/**
 * Writes origin − eye (float64) into the mesh's offset record as two float32 parts whose sum is exact to float32
 * rounding of the residual (ADR 0004): the shader adds both before the rotation-only view matrix.
 */
export function setEyeOffset(offset: EyeOffset, origin: Float64Array, eye: Float64Array): void {
  const x = (origin[0] ?? 0) - (eye[0] ?? 0);
  const y = (origin[1] ?? 0) - (eye[1] ?? 0);
  const z = (origin[2] ?? 0) - (eye[2] ?? 0);
  const hx = Math.fround(x);
  const hy = Math.fround(y);
  const hz = Math.fround(z);
  offset.high.set(hx, hy, hz);
  offset.low.set(x - hx, y - hy, z - hz);
}

const zero = new Vector3();

/** The textured surface material shared by every tile: one shader, per-object offsets. */
export function createSurfaceMaterial(baseImagery: Texture): MeshBasicNodeMaterial {
  const high = uniform(new Vector3()).onObjectUpdate(
    ({ object }) => (object ? offsets.get(object)?.high : undefined) ?? zero,
  );
  const low = uniform(new Vector3()).onObjectUpdate(
    ({ object }) => (object ? offsets.get(object)?.low : undefined) ?? zero,
  );
  const material = new MeshBasicNodeMaterial();
  material.positionNode = positionLocal.add(low).add(high);
  material.colorNode = texture(baseImagery, uv());
  // Skirts face outward on some edges; drawing both sides keeps every crack filled.
  material.side = DoubleSide;
  return material;
}
