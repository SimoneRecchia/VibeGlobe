import { installStyles, uninstallStyles } from '../theme/install.js';

/** Values shown by the debug overlay; `undefined` renders as a dash. */
export interface DebugOverlayValues {
  frameTimeMs: number | undefined;
  framesPerSecond: number | undefined;
}

/** A small panel over the map that shows live engine diagnostics. */
export interface DebugOverlay {
  /** Shows new values. */
  update(values: DebugOverlayValues): void;
  /** Shows static rows such as the active backend and GPU limits, keyed by a metric name (`data-metric`). */
  setInfo(rows: readonly (readonly [metric: string, text: string])[]): void;
  /** Removes the panel from the page. */
  destroy(): void;
}

function format(value: number | undefined, unit: string): string {
  return value === undefined ? `– ${unit}` : `${value.toFixed(1)} ${unit}`;
}

/** Writes the text of the frame-time and frame-rate rows (`undefined` while not measured). */
export type DebugRowFormatter = (metric: 'frame-time' | 'frame-rate', value: number | undefined) => string;

const ENGLISH_ROWS: DebugRowFormatter = (metric, value) =>
  metric === 'frame-time' ? `frame ${format(value, 'ms')}` : `rate  ${format(value, 'fps')}`;

/**
 * Adds the debug overlay to `container`, which should be the positioned element that holds the map; inside a corner of
 * the ui layer it takes its place in the corner's flow instead.
 *
 * @param container - Where the panel goes.
 * @param label - Its accessible name (default 'Engine diagnostics').
 * @param formatRow - The text of the frame-time and frame-rate rows (default English, `frame 16.7 ms`).
 */
export function createDebugOverlay(
  container: HTMLElement,
  label = 'Engine diagnostics',
  formatRow: DebugRowFormatter = ENGLISH_ROWS,
): DebugOverlay {
  const panel = document.createElement('div');
  // Styled by the ui stylesheet's theme variables (F429), installed while a panel exists.
  installStyles();
  panel.className = 'vibeglobe-debug-overlay';
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-label', label);
  const frameTime = document.createElement('div');
  const frameRate = document.createElement('div');
  frameTime.dataset['metric'] = 'frame-time';
  frameRate.dataset['metric'] = 'frame-rate';
  const info = document.createElement('div');
  panel.append(frameTime, frameRate, info);
  container.append(panel);

  let removed = false;
  const overlay: DebugOverlay = {
    update(values) {
      frameTime.textContent = formatRow('frame-time', values.frameTimeMs);
      frameRate.textContent = formatRow('frame-rate', values.framesPerSecond);
    },
    setInfo(rows) {
      info.replaceChildren(
        ...rows.map(([metric, text]) => {
          const row = document.createElement('div');
          row.dataset['metric'] = metric;
          row.textContent = text;
          return row;
        }),
      );
    },
    destroy() {
      if (removed) return;
      removed = true;
      panel.remove();
      uninstallStyles();
    },
  };
  overlay.update({ frameTimeMs: undefined, framesPerSecond: undefined });
  return overlay;
}
