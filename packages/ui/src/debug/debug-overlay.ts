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

/** Adds the debug overlay to `container`, which should be the positioned element that holds the map. */
export function createDebugOverlay(container: HTMLElement): DebugOverlay {
  const panel = document.createElement('div');
  panel.className = 'vibeglobe-debug-overlay';
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-label', 'Engine diagnostics');
  panel.style.cssText =
    'position:absolute;top:8px;left:8px;padding:4px 8px;border-radius:4px;font:12px/1.4 ui-monospace,monospace;' +
    'color:#fff;background:rgba(0,0,0,0.65);pointer-events:none;white-space:pre';
  const frameTime = document.createElement('div');
  const frameRate = document.createElement('div');
  frameTime.dataset['metric'] = 'frame-time';
  frameRate.dataset['metric'] = 'frame-rate';
  const info = document.createElement('div');
  panel.append(frameTime, frameRate, info);
  container.append(panel);

  const overlay: DebugOverlay = {
    update(values) {
      frameTime.textContent = `frame ${format(values.frameTimeMs, 'ms')}`;
      frameRate.textContent = `rate  ${format(values.framesPerSecond, 'fps')}`;
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
      panel.remove();
    },
  };
  overlay.update({ frameTimeMs: undefined, framesPerSecond: undefined });
  return overlay;
}
