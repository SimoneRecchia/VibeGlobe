// The endpoint factory both worker programs share (ADR 0011, ADR 0172): option checks, the same-origin rule, worker
// start-up and messaging. The entries (`index.ts`, `basic.ts`) only add the literal `new Worker(new URL(…))` of their
// program, so a bundler emits only the program an application imports.
import type { TaskTable, WorkerEndpoint, WorkerEndpointFactory, WorkerRequest } from './protocol.js';
import { WORKER_BUILD_ID } from './protocol.js';

/** Options of `createWorkers` (`@vibeglobe/worker` and `@vibeglobe/worker/basic`). */
export interface CreateWorkersOptions {
  /**
   * URL of the worker program (`assets.workerUrl`), resolved against the page. It must be same-origin and neither
   * `blob:` nor `data:`. By default the bundler resolves `vibeglobe-worker.js` next to this module.
   */
  readonly url?: string;
  /** Most workers the pool may start; default `clamp(hardwareConcurrency − 2, 1, 4)`. */
  readonly count?: number;
}

/** Why `createWorkers` refused its options. */
export type WorkerConfigErrorCode = 'cross-origin-url' | 'unsupported-url' | 'invalid-count' | 'no-page';

/** A configuration error raised by `createWorkers` before any worker starts. */
export class WorkerConfigError extends Error {
  readonly code: WorkerConfigErrorCode;

  constructor(code: WorkerConfigErrorCode, message: string) {
    super(message);
    this.name = 'WorkerConfigError';
    this.code = code;
  }
}

const MAX_DEFAULT_WORKERS = 4;
const RESERVED_CORES = 2;

function pageLocation(): Location {
  if (typeof location === 'undefined')
    throw new WorkerConfigError('no-page', 'createWorkers({ url }) resolves the URL against a page; call it in one');
  return location;
}

function sameOriginUrl(raw: string): string {
  const page = pageLocation();
  const url = new URL(raw, page.href);
  if (url.protocol === 'blob:' || url.protocol === 'data:')
    throw new WorkerConfigError('unsupported-url', `the worker URL ${url.protocol} is not allowed; serve the file`);
  if (url.origin !== page.origin)
    throw new WorkerConfigError(
      'cross-origin-url',
      `the worker URL ${url.href} is not on the page's origin ${page.origin}; serve the worker from the page's origin`,
    );
  return url.href;
}

function workerCount(count: number | undefined): number {
  if (count !== undefined) {
    if (!Number.isInteger(count) || count < 1)
      throw new WorkerConfigError('invalid-count', `the worker count must be a positive integer, got ${count}`);
    return count;
  }
  const cores = typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency || 0;
  return Math.min(MAX_DEFAULT_WORKERS, Math.max(1, cores - RESERVED_CORES));
}

function describeError(event: Event, url: string): string {
  if (event instanceof ErrorEvent && event.message !== '') return event.message;
  return (
    `the worker program at ${url} failed to load: a wrong URL, a Content Security Policy that refuses it, ` +
    'or an HTML page served in its place'
  );
}

function connect(
  worker: Worker,
  url: string,
  onMessage: (data: unknown) => void,
  onError: (reason: string) => void,
): WorkerEndpoint {
  worker.onmessage = (event: MessageEvent<unknown>) => onMessage(event.data);
  worker.onerror = (event) => onError(describeError(event, url));
  worker.onmessageerror = () => onError('a message from the worker could not be deserialized');
  return {
    post(message: WorkerRequest, transfer: readonly object[]): void {
      worker.postMessage(message, transfer as Transferable[]);
    },
    terminate(): void {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    },
  };
}

/** Closes the `ImageBitmap` of an output nobody will use, so its memory is freed at once. */
function discardOutput(output: unknown): void {
  if (typeof output !== 'object' || output === null || typeof ImageBitmap === 'undefined') return;
  const image = (output as { image?: unknown }).image;
  if (image instanceof ImageBitmap) image.close();
}

/**
 * The endpoint factory of the worker pool for one worker program: `start` creates the bundled program's worker (the
 * entry's literal `new Worker(new URL(…))`), `options.url` replaces it, and `inline` loads the same tasks for the
 * main-thread executor. `label` names the bundled program in the pool key and in errors.
 */
export function workerFactory(
  options: CreateWorkersOptions,
  label: string,
  start: () => Worker,
  inline: () => Promise<TaskTable>,
): WorkerEndpointFactory {
  const url = options.url === undefined ? undefined : sameOriginUrl(options.url);
  const key = url ?? label;
  return {
    url: key,
    buildId: WORKER_BUILD_ID,
    maxWorkers: workerCount(options.count),
    create(onMessage, onError): WorkerEndpoint {
      const worker = url === undefined ? start() : new Worker(url, { type: 'module', name: 'vibeglobe' });
      return connect(worker, key, onMessage, onError);
    },
    inline,
    discard: discardOutput,
  };
}
