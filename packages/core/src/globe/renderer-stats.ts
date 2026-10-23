/** Renderer diagnostics: captured frames, resource counters and cumulative statistics. */

/** A drawn frame's pixels (test hook). */
export interface FrameCapture {
  /** Drawing-buffer size in device pixels. */
  readonly widthPx: number;
  readonly heightPx: number;
  /** RGBA, 8 bits per channel, not premultiplied, top row first; transparent where nothing was drawn. */
  readonly rgba: Uint8ClampedArray;
}

/** GPU resource counters, all zero after destroy (F068). */
export interface ResourceCounts {
  /** Surface, debug, data-layer and model meshes held on the GPU. */
  readonly meshes: number;
  readonly textures: number;
  /** Bytes of the meshes and textures held, data layers and models included (F385). */
  readonly gpuBytes: number;
  /** WebGL2 vertex array objects held (0 on WebGPU), which must follow the meshes (KB-021). */
  readonly vertexArrays: number;
  /** GPU devices or contexts held: 1 while the globe runs, 0 once released. */
  readonly contexts: number;
}

/** Cumulative renderer counters for diagnostics and tests (F052). */
export interface RendererStats {
  /** Draw calls in the last frame. */
  readonly drawCalls: number;
  /** Triangles in the last frame. */
  readonly triangles: number;
  /** Texture uploads since the renderer started. */
  readonly textureUploads: number;
  /** Surface tile meshes uploaded since the renderer started: a tile's geometry is uploaded once (F152). */
  readonly meshUploads: number;
  /** Automatic object matrix updates since the renderer started (tiles must cause none). */
  readonly matrixUpdates: number;
  /**
   * Render pipelines compiled since the warm-up before the first frame (ADR 0010 §4): 0 while only the warmed-up
   * material variants draw. Debug shapes have their own materials and count.
   */
  readonly pipelineCompiles: number;
  /** Times the render pipeline changed between draws in the last frame, the output pass included (F103). */
  readonly pipelineSwitches: number;
  /** Imagery tile textures held in a block-compressed format (KTX2 sources, ADR 0020). */
  readonly compressedTextures: number;
  /**
   * GPU time of the last frame measured, in milliseconds: null unless the renderer was asked to measure it and the
   * device offers timestamp queries (benchmarks).
   */
  readonly gpuFrameMs: number | null;
}
