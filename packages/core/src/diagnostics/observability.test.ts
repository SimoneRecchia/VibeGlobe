import { describe, expect, it } from 'vitest';
import { createObservability, PHASE_RENDER, PHASE_UPDATE, type LogEntry } from './observability.js';

describe('observability (F118, F120, F121)', () => {
  it('logs at or above the level to the sink, and nothing when silent', () => {
    const entries: LogEntry[] = [];
    const { logger, api } = createObservability(
      'info',
      (entry) => entries.push(entry),
      () => 5,
    );
    logger.log('debug', 'hidden');
    logger.log('info', 'shown');
    api.setLogLevel('error');
    logger.log('warn', 'hidden');
    logger.log('error', 'shown too');
    api.setLogLevel('silent');
    logger.log('error', 'hidden');
    expect(entries).toEqual([
      { level: 'info', message: 'shown', timeMs: 5 },
      { level: 'error', message: 'shown too', timeMs: 5 },
    ]);
  });

  it('times phases only while enabled and records a trace only while it runs', () => {
    let now = 0;
    const { timer, tracer, api } = createObservability('warn', undefined, () => now);
    timer.begin();
    now = 3;
    timer.end(PHASE_UPDATE);
    expect(api.phaseTimesMs().update).toBe(0);
    api.setPhaseTiming(true);
    timer.begin();
    now = 5;
    timer.end(PHASE_UPDATE);
    now = 9;
    timer.end(PHASE_RENDER);
    expect(api.phaseTimesMs()).toMatchObject({ update: 2, render: 4 });
    expect(tracer.enabled).toBe(false);
    api.startTrace();
    tracer.record('request', 'start', '3/4/2');
    expect(api.stopTrace()).toEqual([{ timeMs: 9, kind: 'request', event: 'start', subject: '3/4/2' }]);
    expect(api.stopTrace()).toEqual([]);
  });
});
