/** A minimal typed event emitter; handler errors are isolated so one subscriber cannot break the frame loop. */
export class Emitter<Events extends object> {
  private readonly handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  /** Adds a handler; returns a function that removes it. */
  on<E extends keyof Events>(event: E, handler: (payload: Events[E]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set.delete(handler as (payload: never) => void);
  }

  /** Calls every handler of `event`; a throwing handler is reported asynchronously as an unhandled rejection. */
  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as (payload: Events[E]) => void)(payload);
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
