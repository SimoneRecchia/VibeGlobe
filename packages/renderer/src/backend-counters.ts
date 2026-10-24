import type { RendererStats } from '@vibeglobe/core';
import type { Mesh, WebGPURenderer } from 'three/webgpu';
import { countCalls, countMatrixUpdates, PipelineSwitches, readGpuTime } from './three-hooks.js';

/** The backend's cumulative counters (F052), counted from three.js calls and each frame's render info. */
export class BackendCounters {
  private textureUploads = 0;
  private meshUploads = 0;
  private matrixUpdates = 0;
  private pipelineCompiles = 0;
  private pipelineSwitches: PipelineSwitches | undefined;
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  /** GPU time of the last frame measured, with the `gpuTiming` option and timestamp queries; null otherwise. */
  private gpuFrameMs: number | null = null;
  private readonly storeGpuTime = (ms: number): void => {
    this.gpuFrameMs = ms;
  };

  /** Counts a new renderer's texture uploads, pipeline compiles and pipeline switches. */
  watch(renderer: WebGPURenderer): void {
    countCalls(renderer.backend, 'updateTexture', () => this.textureUploads++);
    countCalls(renderer.backend, 'createRenderPipeline', () => this.pipelineCompiles++);
    this.pipelineSwitches = new PipelineSwitches(renderer.backend);
  }

  /** Counts a new mesh and its matrix updates. */
  meshAdded(mesh: Mesh): void {
    countMatrixUpdates(mesh, () => this.matrixUpdates++);
    this.meshUploads++;
  }

  /** Pipeline compiles count from here: after the warm-up before the first frame (ADR 0010 §4). */
  resetCompiles(): void {
    this.pipelineCompiles = 0;
  }

  /** Before a frame's render call. */
  beforeRender(): void {
    this.pipelineSwitches?.begin();
  }

  /** After a frame's render call: its draw calls, triangles and, with `gpuTiming`, its GPU time. */
  afterRender(renderer: WebGPURenderer, gpuTiming: boolean): void {
    if (gpuTiming) readGpuTime(renderer, this.storeGpuTime);
    const info = renderer.info.render as { drawCalls?: number; calls?: number; triangles: number };
    this.lastDrawCalls = info.drawCalls ?? info.calls ?? 0;
    this.lastTriangles = info.triangles;
  }

  /** The counters, with the count of compressed imagery textures held. */
  stats(compressedTextures: number): RendererStats {
    return {
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      textureUploads: this.textureUploads,
      meshUploads: this.meshUploads,
      matrixUpdates: this.matrixUpdates,
      pipelineCompiles: this.pipelineCompiles,
      pipelineSwitches: this.pipelineSwitches?.count ?? 0,
      compressedTextures,
      gpuFrameMs: this.gpuFrameMs,
    };
  }
}
