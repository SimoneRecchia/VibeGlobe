// Slow responses of the fixture server: one response's body at a fixed rate, or the bodies of a session's responses
// sharing one link (F092, F300–F303).
import type { ServerResponse } from 'node:http';

/** A session's link: when it is free again, in `performance.now()` milliseconds. */
export interface Link {
  linkFreeMs?: number;
}

/** Sends `body` at `bytesPerS`: a tenth of a second's worth every 100 ms; `done` when the last byte is written. */
export function sendThrottled(res: ServerResponse, body: Buffer, bytesPerS: number, done: () => void): void {
  const chunk = Math.max(1, Math.round(bytesPerS / 10));
  let offset = 0;
  const send = (): void => {
    if (res.destroyed) return;
    const end = Math.min(body.length, offset + chunk);
    res.write(body.subarray(offset, end));
    offset = end;
    if (offset < body.length) {
      setTimeout(send, 100);
    } else {
      done();
      res.end();
    }
  };
  send();
}

/**
 * Sends `body` over a link of `bytesPerS` shared with the other responses of the session: each 10 ms slice waits for
 * the slices queued on the link before it, as on a real connection; `done` when the last byte is written.
 */
export function sendOverLink(link: Link, bytesPerS: number, res: ServerResponse, body: Buffer, done: () => void): void {
  const slice = Math.max(1, Math.round(bytesPerS / 100));
  let offset = 0;
  const queue = (): void => {
    const now = performance.now();
    const startMs = Math.max(now, link.linkFreeMs ?? 0);
    link.linkFreeMs = startMs + (1000 * Math.min(slice, body.length - offset)) / bytesPerS;
    setTimeout(send, link.linkFreeMs - now);
  };
  const send = (): void => {
    if (res.destroyed) return;
    const end = Math.min(body.length, offset + slice);
    res.write(body.subarray(offset, end));
    offset = end;
    if (offset < body.length) return queue();
    done();
    res.end();
  };
  queue();
}
