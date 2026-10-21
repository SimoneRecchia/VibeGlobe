import type { DepthPath } from '@vibeglobe/core';
import { Camera } from 'three/webgpu';

/** The engine's matrices for one frame, column-major float64 (`FrameView`'s). */
export interface CameraMatrices {
  /** Rotation-only view: the eye is at the origin of the eye-relative space (ADR 0004). */
  readonly view: Float64Array;
  /** Reversed-Z infinite projection, near plane in element 14 (ADR 0005). */
  readonly projection: Float64Array;
}

/** A camera whose matrices the engine writes every frame; three.js must not recompute them. */
export class EngineCamera extends Camera {
  /**
   * The near plane in meters, which three.js's `cameraNear` node reads (the fragment depth path, ADR 0005). Written
   * every frame; a fractional initial value keeps the field a double updated in place (ADR 0018).
   */
  near = 0.1;

  /** Intentionally empty: the engine supplies the reversed-Z infinite projection (ADR 0005). */
  updateProjectionMatrix(): void {}

  /** Writes the engine's view and projection, adapted to the depth path. */
  apply(matrices: CameraMatrices, depthPath: DepthPath): void {
    this.matrixWorldInverse.fromArray(matrices.view);
    this.matrixWorld.copy(this.matrixWorldInverse).invert();
    this.projectionMatrix.fromArray(matrices.projection);
    if (depthPath === 'fragment') {
      // The engine's projection clips z to [0, w] with z = near (ADR 0005 §2), near being its element 14. WebGL2 clips
      // z to [−w, w]: z = 2·near − d clips at d = near and nowhere else; the depth comes from the shader, which reads
      // near from the camera. It is stored only when it changes, since three.js reads it as a number uniform and a new
      // value is a new heap number (ADR 0018); near stays 0.1 m except within 20 cm of the ground (ADR 0005 §5).
      const near = matrices.projection[14] ?? 0;
      if (near !== this.near) this.near = near;
      const projection = this.projectionMatrix.elements;
      projection[10] = 1;
      projection[14] = 2 * near;
    }
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }
}
