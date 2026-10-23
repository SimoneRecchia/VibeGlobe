import type { ModelDescription } from './description.js';
import { ModelError, type ModelErrorCode } from './errors.js';
import { isGlb } from './glb.js';
import { readDocument, type ModelLimits } from './parse.js';
import { externalUris } from './resources.js';
import { PARSE_MODEL_TASK, type ParseModelTaskInput } from './tasks.js';

/** Runs a worker task and resolves with its output: the engine's worker pool ({@link poolRunner}) or any worker. */
export type ModelTaskRunner = (task: string, input: unknown, transfer: readonly object[]) => Promise<unknown>;

/** Fetches a file's bytes; rejects when it cannot. */
export type ModelFetch = (url: string) => Promise<Uint8Array>;

/** Options of {@link createModelLoader}. */
export interface ModelLoaderOptions {
  /** Runs the `parse-model` task in a worker. */
  readonly run: ModelTaskRunner;
  /** Fetches the model and its external files (default: `fetch`). */
  readonly fetch?: ModelFetch;
  readonly limits?: ModelLimits;
}

/** Loads models off the main thread. */
export interface ModelLoader {
  /**
   * Loads a `.glb` or `.gltf` model from a URL (external files relative to it) or from bytes, decoding it in a worker.
   * Rejects with a ModelError for a missing, truncated, corrupt or unsupported file.
   */
  load(source: { readonly url?: string; readonly data?: ArrayBuffer }): Promise<ModelDescription>;
}

const MODEL_ERROR_CODES: readonly string[] = [
  'invalid-glb',
  'invalid-json',
  'invalid-gltf',
  'unsupported',
  'missing-resource',
  'decode-failed',
  'too-large',
];

const defaultFetch: ModelFetch = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

/** The part of the engine's worker pool (ADR 0011) a model loader uses. */
export interface WorkerPoolLike {
  run(
    request: { readonly task: string; readonly input: unknown; readonly transfer?: readonly object[] },
    done: (
      outcome: { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: Error },
    ) => void,
  ): unknown;
}

/** A {@link ModelTaskRunner} over the engine's worker pool. */
export function poolRunner(pool: WorkerPoolLike): ModelTaskRunner {
  return (task, input, transfer) =>
    new Promise((resolve, reject) => {
      pool.run({ task, input, transfer }, (outcome) => {
        if (outcome.ok) resolve(outcome.output);
        else reject(outcome.error);
      });
    });
}

/** Turns a task failure into a ModelError, keeping the model error code the worker reported. */
function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  const record = error as { taskCode?: unknown; code?: unknown; message?: unknown } | null;
  const code = [record?.taskCode, record?.code].find(
    (c): c is ModelErrorCode => typeof c === 'string' && MODEL_ERROR_CODES.includes(c),
  );
  return new ModelError(
    code ?? 'decode-failed',
    typeof record?.message === 'string' ? record.message : 'the model task failed',
    {
      cause: error,
    },
  );
}

/**
 * Creates a model loader (F361): the main thread fetches the file and, for a `.gltf`, the external buffers and images
 * its document names (the JSON is validated here first, so a broken document fails before any fetch); the worker
 * parses, validates and decodes everything, Draco and meshopt included.
 */
export function createModelLoader(options: ModelLoaderOptions): ModelLoader {
  const fetchBytes = options.fetch ?? defaultFetch;
  const get = async (url: string): Promise<Uint8Array> => {
    try {
      return await fetchBytes(url);
    } catch (cause) {
      throw new ModelError('missing-resource', `${url} could not be fetched`, { cause });
    }
  };
  return {
    async load(source) {
      if ((source.url === undefined) === (source.data === undefined))
        throw new ModelError('invalid-gltf', 'a model needs either a url or data');
      const bytes = source.data ? new Uint8Array(source.data.slice(0)) : await get(source.url ?? '');
      const resources: Record<string, ArrayBuffer> = {};
      if (!isGlb(bytes)) {
        const { doc } = readDocument(bytes);
        const base = source.url;
        await Promise.all(
          externalUris(doc).map(async (uri) => {
            if (base === undefined)
              throw new ModelError('missing-resource', `${uri}: a model given as data cannot refer to files`);
            const file = await get(new URL(uri, new URL(base, globalThis.location?.href ?? 'file:///')).href);
            resources[uri] =
              file.buffer.byteLength === file.byteLength
                ? (file.buffer as ArrayBuffer)
                : (file.slice().buffer as ArrayBuffer);
          }),
        );
      }
      const body =
        bytes.buffer.byteLength === bytes.byteLength
          ? (bytes.buffer as ArrayBuffer)
          : (bytes.slice().buffer as ArrayBuffer);
      const input: ParseModelTaskInput = {
        bytes: body,
        resources,
        ...(options.limits ? { limits: options.limits } : {}),
      };
      try {
        return (await options.run(PARSE_MODEL_TASK, input, [body, ...Object.values(resources)])) as ModelDescription;
      } catch (error) {
        throw toModelError(error);
      }
    },
  };
}
