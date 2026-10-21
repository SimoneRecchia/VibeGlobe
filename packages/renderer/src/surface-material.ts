import { texture, uv } from 'three/tsl';
import { DoubleSide, MeshBasicNodeMaterial, type Object3D, type Texture } from 'three/webgpu';

/**
 * Places an object eye-relative (ADR 0004): the translation of its world matrix becomes origin − eye, computed in
 * float64, and the rest stays the identity it was created with. three.js multiplies it by the rotation-only view matrix
 * in float64 and rounds the model-view matrix to float32 only at upload, so the translation keeps float32 precision
 * relative to the object's distance from the eye, with no per-object uniforms. Splitting the translation into two
 * float32 parts would add nothing, because the shader sums them in float32 anyway. The elements are written directly:
 * Matrix4.makeTranslation takes doubles as arguments, which V8 boxes every frame (ADR 0018).
 */
export function placeEyeRelative(object: Object3D, origin: Float64Array, eye: Float64Array): void {
  const elements = object.matrixWorld.elements;
  elements[12] = (origin[0] ?? 0) - (eye[0] ?? 0);
  elements[13] = (origin[1] ?? 0) - (eye[1] ?? 0);
  elements[14] = (origin[2] ?? 0) - (eye[2] ?? 0);
}

/** The textured surface material shared by every tile: one shader for the whole surface. */
export function createSurfaceMaterial(baseImagery: Texture): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.colorNode = texture(baseImagery, uv());
  // Skirts face outward on some edges; drawing both sides keeps every crack filled.
  material.side = DoubleSide;
  return material;
}
