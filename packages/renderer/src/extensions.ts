import type { DepthPath, FrameView, RenderExtension } from '@vibeglobe/core';
import type { Scene } from 'three/webgpu';

/**
 * What a render extension of the three.js renderer receives as `context.renderer` (`Globe.addRenderExtension`, M13):
 * the scene it adds its objects to, and the depth path its materials must follow (ADR 0005: reversed-z, or fragment-written depth
 * where the device lacks clip control). Objects are placed camera-relative: their
 * positions are offsets from `FrameView.eyeEcef`, so they stay precise at street level (ADR 0004).
 */
export interface ThreeExtensionContext {
  readonly scene: Scene;
  depthPath(): DepthPath;
}

/** The render extensions of one renderer: placed every frame before drawing, disposed on removal or destruction. */
export class RenderExtensions {
  private readonly active = new Set<RenderExtension>();

  /** `context` is what every extension of this renderer receives. */
  constructor(readonly context: ThreeExtensionContext) {}

  /** Adds an extension; returns the function that removes and disposes it. */
  add(extension: RenderExtension): () => void {
    this.active.add(extension);
    return () => {
      if (this.active.delete(extension)) extension.dispose();
    };
  }

  /** Places every extension's objects for the frame. */
  frame(view: FrameView): void {
    for (const extension of this.active) extension.frame(view);
  }

  /** Disposes every extension (the renderer is destroyed). */
  dispose(): void {
    for (const extension of this.active) extension.dispose();
    this.active.clear();
  }
}
