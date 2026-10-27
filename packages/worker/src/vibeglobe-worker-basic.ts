// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Entry of the basic worker program (ADR 0172): the module worker of `@vibeglobe/worker/basic`, running only the basic
 * tasks (imagery, terrain, KTX2, vector parsers), so it imports nothing from `@vibeglobe/layers` or `@vibeglobe/models`. It installs the message handler and posts the `ready` handshake as soon as the module has evaluated.
 *
 * Only the pool loads this module, as a worker; nothing imports it on the main thread (the inline executor imports
 * `basic-tasks.js` instead), so touching the global scope here never affects the page.
 */
import { createTaskHost } from './task-host.js';
import { BASIC_TASKS } from './basic-tasks.js';

/**
 * The part of the dedicated worker global scope this module uses. The package compiles against the DOM library for
 * its main-thread entry, and the `WebWorker` library cannot be combined with it, so the scope is typed here.
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;
// A task module that failed to load stays failed in this worker (TG-04): an uncaught error makes the pool replace it.
const host = createTaskHost(
  BASIC_TASKS,
  (message, transfer) => scope.postMessage(message, transfer),
  () =>
    setTimeout(() => {
      throw new Error('task module unavailable');
    }, 0),
);
scope.onmessage = (event) => host.receive(event.data);
host.announce();
