import { FRAME_PHASES, type Globe } from '@vibeglobe/core';

/**
 * The compact performance HUD (F119): frame time, frame rate and the engine's per-phase costs, refreshed twice a
 * second. It turns the engine's phase timing on while shown (docs/guides/debugging.md documents its overhead).
 */

const REFRESH_MS = 500;
const SAMPLES = 60;

/** Shows or hides the HUD over `host`; returns the switch. */
export function createHud(globe: Globe, host: HTMLElement): (on: boolean) => void {
  let element: HTMLDivElement | undefined;
  let stopFrames: (() => void) | undefined;
  let timer: number | undefined;
  const intervals = new Float64Array(SAMPLES);
  let count = 0;
  let lastMs = 0;
  const render = (): void => {
    if (!element) return;
    const n = Math.min(count, SAMPLES);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += intervals[i] ?? 0;
    const frameMs = n > 0 ? sum / n : 0;
    const phases = globe.diagnostics.phaseTimesMs();
    element.textContent =
      `${frameMs.toFixed(1)} ms · ${frameMs > 0 ? Math.round(1000 / frameMs) : 0} fps\n` +
      FRAME_PHASES.map((phase) => `${phase} ${phases[phase].toFixed(2)}`).join(' · ');
  };
  return (on) => {
    if (on && !element) {
      element = document.createElement('div');
      element.className = 'vibeglobe-hud';
      host.append(element);
      // Durations only: User Timing entries would cost the page more than the HUD itself.
      globe.diagnostics.setPhaseTiming(true, false);
      stopFrames = globe.on('frame', () => {
        const nowMs = performance.now();
        if (lastMs > 0) intervals[count++ % SAMPLES] = nowMs - lastMs;
        lastMs = nowMs;
      });
      render();
      timer = window.setInterval(render, REFRESH_MS);
    } else if (!on && element) {
      window.clearInterval(timer);
      stopFrames?.();
      globe.diagnostics.setPhaseTiming(false);
      element.remove();
      element = undefined;
    }
  };
}
