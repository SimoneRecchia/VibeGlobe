// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { TaskError, type TaskFunction, type TaskTable } from './protocol.js';

/** Task tables being loaded or loaded, by name. */
const tables = new Map<string, Promise<TaskTable>>();

/**
 * The tasks of a table another package provides, imported on the first of them in its own chunk (the vector parsers of
 * `@vibeglobe/sources`, clustering and vector-tile layout of `@vibeglobe/layers`, glTF parsing of `@vibeglobe/models`).
 * A failed import is not kept: the task fails with `module-unavailable`, and the next one imports again, in a new
 * worker, since a browser keeps a failed dynamic import for the life of its context (TG-04).
 */
export function lazyTable(table: string, load: () => Promise<TaskTable>): (name: string) => TaskFunction {
  return (name) => async (input, context) => {
    let tasks = tables.get(table);
    if (!tasks) tables.set(table, (tasks = load()));
    const task = (
      await tasks.catch((error: unknown) => {
        tables.delete(table);
        throw new TaskError('module-unavailable', String(error));
      })
    )[name];
    if (!task) throw new TaskError('unknown-task', `no ${table} task ${name}`);
    return task(input, context);
  };
}
