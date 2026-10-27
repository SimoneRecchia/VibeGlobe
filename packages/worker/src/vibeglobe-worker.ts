// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Entry of the worker program (ADR 0011 rule 5): one module worker that runs every built-in task for the page-wide
 * pool. It installs the message handler and posts the `ready` handshake as soon as the module has evaluated.
 *
 * Only the pool loads this module, as a worker; nothing imports it on the main thread (the inline executor imports
 * `tasks.js` instead), so touching the global scope here never affects the page.
 */
import { createTaskHost } from './task-host.js';
import { TASKS } from './tasks.js';

/**
 * The part of the dedicated worker global scope this module uses. The package compiles against the DOM library for
 * its main-thread entry, and the `WebWorker` library cannot be combined with it, so the scope is typed here.
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;
// A task module that failed to load stays failed in this worker's module map (TG-04): an uncaught error makes the pool
// replace the worker, whose new module map loads it again.
const host = createTaskHost(
  TASKS,
  (message, transfer) => scope.postMessage(message, transfer),
  () =>
    setTimeout(() => {
      throw new Error('task module unavailable');
    }, 0),
);
scope.onmessage = (event) => host.receive(event.data);
host.announce();
