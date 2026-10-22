/**
 * Every built-in task by name: the table the worker program registers, and the one the inline executor loads lazily
 * after repeated worker start failures (ADR 0011 rule 6). Later increments add tasks from `sources` and `layers`.
 */
import { decodeImage } from './decode-image.js';
import type { TaskTable } from './protocol.js';
import { transcodeKtx2 } from './transcode-ktx2.js';

/** The built-in tasks. */
export const TASKS: TaskTable = Object.freeze({
  'decode-image': decodeImage,
  'transcode-ktx2': transcodeKtx2,
});
