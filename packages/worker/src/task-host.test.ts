import { describe, expect, it } from 'vitest';
import type { TaskTable, WorkerMessage } from './protocol.js';
import { createTaskHost } from './task-host.js';
import { lazyTable } from './lazy-task.js';

describe('a task whose module fails to load (TG-04)', () => {
  it('fails with module-unavailable, asks for the worker to be replaced, and loads the module again next time', async () => {
    let loads = 0;
    const table: TaskTable = {
      lazy: lazyTable('test-table', () => {
        loads++;
        return loads === 1
          ? Promise.reject(new TypeError('Failed to fetch dynamically imported module'))
          : Promise.resolve({ lazy: () => ({ output: 'ok', transfer: [] }) });
      })('lazy'),
    };
    const replies: WorkerMessage[] = [];
    let broken = 0;
    const host = createTaskHost(
      table,
      (message) => replies.push(message),
      () => broken++,
    );
    const run = async (id: number): Promise<void> => {
      host.receive({ kind: 'run', id, task: 'lazy', input: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await run(1);
    expect(replies[0]).toMatchObject({ kind: 'reply', id: 1, ok: false, error: { code: 'module-unavailable' } });
    expect(broken).toBe(1);
    await run(2);
    expect(replies[1]).toMatchObject({ kind: 'reply', id: 2, ok: true, output: 'ok' });
    expect(loads).toBe(2);
    expect(broken).toBe(1);
  });
});
