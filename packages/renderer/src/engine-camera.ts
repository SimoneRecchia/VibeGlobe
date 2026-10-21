import { Camera } from 'three/webgpu';

/** A camera whose matrices the engine writes every frame; three.js must not recompute them. */
export class EngineCamera extends Camera {
  /**
   * The near plane in meters, which three.js's `cameraNear` node reads (the fragment depth path, ADR 0005). Written
   * every frame; a fractional initial value keeps the field a double updated in place (ADR 0018).
   */
  near = 0.1;

  /** Intentionally empty: the engine supplies the reversed-Z infinite projection (ADR 0005). */
  updateProjectionMatrix(): void {}
}
