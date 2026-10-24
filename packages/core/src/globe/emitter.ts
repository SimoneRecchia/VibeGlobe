// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * A minimal typed event emitter; handler errors are isolated so one subscriber cannot break the frame loop. Handlers
 * live in arrays replaced on change (copy on write), so emitting allocates nothing.
 */
export class Emitter<Events extends object> {
  private readonly handlers = new Map<keyof Events, readonly ((payload: never) => void)[]>();

  /** Adds a handler; returns a function that removes it. */
  on<E extends keyof Events>(event: E, handler: (payload: Events[E]) => void): () => void {
    const entry = handler as (payload: never) => void;
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), entry]);
    return () => {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((existing) => existing !== entry),
      );
    };
  }

  /** True when `event` has at least one handler, so callers can skip building a payload nobody reads. */
  has(event: keyof Events): boolean {
    return (this.handlers.get(event)?.length ?? 0) > 0;
  }

  /** Calls every handler of `event`; a throwing handler is reported asynchronously as an unhandled rejection. */
  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    const list = this.handlers.get(event);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try {
        (list[i] as (payload: Events[E]) => void)(payload);
      } catch (error) {
        void Promise.reject(error);
      }
    }
  }

  /** Removes every handler. */
  clear(): void {
    this.handlers.clear();
  }
}
