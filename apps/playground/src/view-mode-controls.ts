import type { Globe, ViewMode } from '@vibeglobe/core';

/** Which button stands for each mode: manual mode is what 3D chooses. */
const BUTTONS: readonly { readonly mode: '2d' | '3d' | 'auto'; readonly label: string; readonly shows: ViewMode }[] = [
  { mode: '2d', label: '2D', shows: '2d' },
  { mode: '3d', label: '3D', shows: 'manual' },
  { mode: 'auto', label: 'Auto', shows: 'auto' },
];

/**
 * The playground's 2D / 3D / Auto toggle (F163): three buttons next to each other, the active mode pressed. The
 * engine's `view-mode-change` events keep them in step with modes chosen elsewhere (a view with a tilt). `?viewMode=`
 * picks a mode at start.
 */
export function showViewModeControls(globe: Globe, app: HTMLElement, requested: string | null): void {
  const group = document.createElement('div');
  group.id = 'view-modes';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'View mode');
  const buttons = BUTTONS.map(({ mode, label, shows }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset['mode'] = mode;
    button.addEventListener('click', () => globe.setViewMode(mode));
    group.append(button);
    return { button, shows };
  });
  const reflect = (mode: ViewMode): void => {
    for (const { button, shows } of buttons) button.setAttribute('aria-pressed', String(shows === mode));
  };
  globe.on('view-mode-change', ({ mode }) => reflect(mode));
  reflect(globe.viewMode);
  app.append(group);
  if (requested === '2d' || requested === '3d' || requested === 'auto') globe.setViewMode(requested);
}
