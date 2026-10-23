// Slow responses of the fixture server: one response's body at a fixed rate, or the bodies of a session's responses
// sharing one link (F092, F300–F303).
import type { ServerResponse } from 'node:http';

/** A session's link: the responses sharing it, served in turn by one pump. */
export interface Link {
  linkFreeMs?: number;
  linkQueue?: Transfer[];
}

/** A response streaming its body over a link. */
interface Transfer {
  readonly res: ServerResponse;
  readonly body: Buffer;
  offset: number;
  readonly done: () => void;
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
 * Sends `body` over a link of `bytesPerS` shared with the other responses of the session, as on a real connection:
 * the responses take turns, 10 ms of the link each, and a response the client closed stops using it at once (an
 * aborted tile costs the link nothing more); `done` when the last byte is written.
 */
export function sendOverLink(link: Link, bytesPerS: number, res: ServerResponse, body: Buffer, done: () => void): void {
  const queue = (link.linkQueue ??= []);
  queue.push({ res, body, offset: 0, done });
  if (queue.length === 1) pump(link, bytesPerS, false);
}

/**
 * Serves the link's queue: a slice of the first response, which then goes to the back until its body is sent. While
 * the queue stays busy (`backlog`) each slice follows the previous one on the link's clock, so a late timer is made
 * up rather than lost; an idle link starts again from now.
 */
function pump(link: Link, bytesPerS: number, backlog: boolean): void {
  const queue = link.linkQueue ?? [];
  while (queue[0]?.res.destroyed) queue.shift();
  const transfer = queue[0];
  if (!transfer) return;
  const slice = Math.min(Math.max(1, Math.round(bytesPerS / 100)), transfer.body.length - transfer.offset);
  const startMs = backlog ? (link.linkFreeMs ?? 0) : Math.max(performance.now(), link.linkFreeMs ?? 0);
  link.linkFreeMs = startMs + (1000 * slice) / bytesPerS;
  waitUntil(link.linkFreeMs, () => {
    queue.shift();
    if (!transfer.res.destroyed) {
      transfer.res.write(transfer.body.subarray(transfer.offset, transfer.offset + slice));
      transfer.offset += slice;
      if (transfer.offset < transfer.body.length) queue.push(transfer);
      else {
        transfer.done();
        transfer.res.end();
      }
    }
    pump(link, bytesPerS, true);
  });
}

/**
 * Calls `then` at `targetMs` (`performance.now()`) to a fraction of a millisecond: timers fire a millisecond or more
 * late, which on a 50 Mbps link is longer than a small tile's whole transfer (F300).
 */
function waitUntil(targetMs: number, then: () => void): void {
  const leftMs = targetMs - performance.now();
  if (leftMs > 2) setTimeout(() => waitUntil(targetMs, then), leftMs - 1);
  else if (leftMs > 0) setImmediate(() => waitUntil(targetMs, then));
  else then();
}
