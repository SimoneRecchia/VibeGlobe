// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The `transcode-ktx2` task (ADR 0020 rules 2–4): KTX2 bytes in, a tile in the GPU format the device decodes out. The
 * reader in core validates the file and predicts every level's size before the transcoder runs; the transcoder is
 * VibeGlobe's own WebAssembly build of Basis Universal (`wasm/vibeglobe-basis.wasm`), with a plain C interface and
 * no JavaScript glue, loaded on the first KTX2 task only, so pages without KTX2 sources never download it. The worker
 * program imports this module with its first KTX2 task (KB-295); `@vibeglobe/worker/transcode-ktx2` gives
 * `createTranscodeKtx2` to tests and tools that bring their own transcoder.
 * @module @vibeglobe/worker/transcode-ktx2
 */
import {
  chooseKtx2Target,
  Ktx2Error,
  KTX2_TARGET_CODES,
  ktx2GpuBytes,
  ktx2LevelBytes,
  ktx2LevelRange,
  ktx2LevelSize,
  readKtx2,
} from '@vibeglobe/core/decoders';
import type { CompressedLevel, CompressedTileImage, Ktx2Info, Ktx2Target } from '@vibeglobe/core';
import { TaskError, type TaskContext, type TaskOutput } from './protocol.js';
import { compileWasm } from './wasm.js';

/** Input of `transcode-ktx2`: the file (transferred) and the compressed families the device decodes. */
export interface TranscodeKtx2Input {
  readonly bytes: ArrayBuffer;
  readonly formats: readonly string[];
}

/** The exports of `vibeglobe-basis.wasm` (`wasm/basis-transcoder.cpp`). */
interface TranscoderExports {
  readonly memory: WebAssembly.Memory;
  _initialize(): void;
  vg_alloc(bytes: number): number;
  vg_free(pointer: number): void;
  vg_open(data: number, bytes: number): number;
  vg_transcode(transcoder: number, level: number, target: number, out: number, capacity: number): number;
  vg_close(transcoder: number): void;
}

/** Loads the compiled transcoder module. */
export type TranscoderLoader = () => Promise<WebAssembly.Module>;

/** WASI's "function not supported": the transcoder writes no files and needs no randomness. */
const ENOSYS = 52;
const unsupportedCall = (): number => ENOSYS;
const WASI_IMPORTS = {
  wasi_snapshot_preview1: {
    fd_close: unsupportedCall,
    fd_fdstat_get: unsupportedCall,
    fd_seek: unsupportedCall,
    fd_write: unsupportedCall,
    random_get: unsupportedCall,
  },
};

/** The bundled transcoder, next to this module (`assets.wasmBaseUrl` defaults to the worker's directory). */
const TRANSCODER_URL = new URL('../wasm/vibeglobe-basis.wasm', import.meta.url);

/** Fetches and compiles the bundled transcoder. */
const fetchTranscoder: TranscoderLoader = () => compileWasm(TRANSCODER_URL);

function parseInput(input: unknown): TranscodeKtx2Input {
  if (typeof input !== 'object' || input === null)
    throw new TaskError('invalid-input', 'transcode-ktx2 needs an object');
  const { bytes, formats } = input as Partial<Record<keyof TranscodeKtx2Input, unknown>>;
  if (!(bytes instanceof ArrayBuffer))
    throw new TaskError('invalid-input', 'transcode-ktx2 needs `bytes` (ArrayBuffer)');
  if (!Array.isArray(formats) || !formats.every((format) => typeof format === 'string'))
    throw new TaskError('invalid-input', 'transcode-ktx2 needs `formats` (string[])');
  return { bytes, formats: formats as string[] };
}

function readOrFail(bytes: Uint8Array): Ktx2Info {
  try {
    return readKtx2(bytes);
  } catch (error) {
    if (!(error instanceof Ktx2Error)) throw error;
    throw new TaskError(error.code === 'invalid' ? 'undecodable' : 'format-unsupported', error.message);
  }
}

function cancelled(): TaskError {
  return new TaskError('cancelled', 'transcode-ktx2 was cancelled');
}

/** Copies the levels of a raw file whose blocks the device decodes as they are. */
function passThrough(bytes: Uint8Array, info: Ktx2Info, target: Exclude<Ktx2Target, 'rgba8'>): CompressedLevel[] {
  const levels: CompressedLevel[] = [];
  for (let level = 0; level < info.levelCount; level++) {
    const [widthPx, heightPx] = ktx2LevelSize(info.widthPx, info.heightPx, level);
    const [offset, length] = ktx2LevelRange(bytes, level);
    if (length !== ktx2LevelBytes(target, widthPx, heightPx))
      throw new TaskError(
        'undecodable',
        `level ${level} holds ${length} bytes, not a ${widthPx}×${heightPx} ${target}`,
      );
    levels.push({ data: bytes.slice(offset, offset + length), widthPx, heightPx });
  }
  return levels;
}

/** Runs the transcoder over the levels it is asked for, freeing everything it allocated. */
function transcode(
  wasm: TranscoderExports,
  bytes: Uint8Array,
  info: Ktx2Info,
  target: Ktx2Target,
  levelCount: number,
  context: TaskContext,
): CompressedLevel[] {
  const input = wasm.vg_alloc(bytes.length);
  if (input === 0) throw new TaskError('undecodable', `the transcoder could not hold ${bytes.length} bytes`);
  let transcoder = 0;
  try {
    new Uint8Array(wasm.memory.buffer, input, bytes.length).set(bytes);
    transcoder = wasm.vg_open(input, bytes.length);
    if (transcoder === 0) throw new TaskError('undecodable', 'the transcoder refused the file');
    const levels: CompressedLevel[] = [];
    for (let level = 0; level < levelCount; level++) {
      if (context.isCancelled()) throw cancelled();
      const [widthPx, heightPx] = ktx2LevelSize(info.widthPx, info.heightPx, level);
      const length = ktx2LevelBytes(target, widthPx, heightPx);
      // Capacity in blocks, or in pixels for RGBA32.
      const capacity = target === 'rgba8' ? widthPx * heightPx : Math.ceil(widthPx / 4) * Math.ceil(heightPx / 4);
      const out = wasm.vg_alloc(length);
      if (out === 0) throw new TaskError('undecodable', `the transcoder could not hold ${length} bytes`);
      try {
        if (wasm.vg_transcode(transcoder, level, KTX2_TARGET_CODES[target], out, capacity) !== 1)
          throw new TaskError('undecodable', `level ${level} could not be transcoded to ${target}`);
        levels.push({ data: new Uint8Array(wasm.memory.buffer, out, length).slice(), widthPx, heightPx });
      } finally {
        wasm.vg_free(out);
      }
    }
    return levels;
  } finally {
    if (transcoder !== 0) wasm.vg_close(transcoder);
    wasm.vg_free(input);
  }
}

/**
 * Creates the task over a transcoder loader. The module is loaded and instantiated once per worker, on the first
 * KTX2 file; if that fails (missing file, WebAssembly refused by the Content Security Policy), every KTX2 tile fails
 * with `format-unsupported` and there is no JavaScript fallback (ADR 0020 rule 4).
 */
export function createTranscodeKtx2(load: TranscoderLoader) {
  let instance: Promise<TranscoderExports> | undefined;
  const transcoder = (): Promise<TranscoderExports> =>
    (instance ??= load()
      .then((module) => WebAssembly.instantiate(module, WASI_IMPORTS))
      .then((created) => {
        const wasm = created.exports as unknown as TranscoderExports;
        wasm._initialize();
        return wasm;
      })
      .catch((error: unknown) => {
        // A failed load (a reset connection) is not kept: the next KTX2 task loads it again (TH-01).
        instance = undefined;
        const reason = error instanceof Error ? error.message : String(error);
        throw new TaskError('format-unsupported', `the KTX2 transcoder could not be loaded: ${reason}`);
      }));

  /**
   * Transcodes a KTX2 file. Fails with `invalid-input` for a malformed input, `undecodable` for a broken file,
   * `format-unsupported` for a valid file the engine or device cannot use or when the transcoder cannot load, and
   * `cancelled` between levels.
   */
  return async function transcodeKtx2(input: unknown, context: TaskContext): Promise<TaskOutput> {
    const { bytes: buffer, formats } = parseInput(input);
    const bytes = new Uint8Array(buffer);
    const info = readOrFail(bytes);
    const target = chooseKtx2Target(info, formats);
    if (target === undefined)
      throw new TaskError('format-unsupported', `the device decodes none of the file's ${info.rawTarget} blocks`);
    if (context.isCancelled()) throw cancelled();
    const gpuBytes = ktx2GpuBytes(info, target);
    const base = { widthPx: info.widthPx, heightPx: info.heightPx, gpuBytes };
    let levels: CompressedLevel[];
    if (info.kind === 'raw' && target !== 'rgba8') levels = passThrough(bytes, info, target);
    else if (info.kind === 'raw') levels = [rawRgba(bytes, info)];
    else levels = transcode(await transcoder(), bytes, info, target, target === 'rgba8' ? 1 : info.levelCount, context);
    if (context.isCancelled()) throw cancelled();
    const transfer = levels.map((level) => level.data.buffer);
    if (target === 'rgba8') {
      const level = levels[0] as CompressedLevel;
      return {
        output: { ...base, image: { data: level.data, width: level.widthPx, height: level.heightPx } },
        transfer,
      };
    }
    const image: CompressedTileImage = { kind: 'compressed', target, srgb: info.srgb, levels };
    return { output: { ...base, image }, transfer };
  };
}

/** The base level of a raw RGBA8 file. */
function rawRgba(bytes: Uint8Array, info: Ktx2Info): CompressedLevel {
  const [offset, length] = ktx2LevelRange(bytes, 0);
  if (length !== info.widthPx * info.heightPx * 4)
    throw new TaskError('undecodable', `level 0 holds ${length} bytes, not ${info.widthPx}×${info.heightPx} RGBA8`);
  return { data: bytes.slice(offset, offset + length), widthPx: info.widthPx, heightPx: info.heightPx };
}

/** The task with the bundled transcoder. */
export const transcodeKtx2 = createTranscodeKtx2(fetchTranscoder);
