import { THEME_VARIABLES, type ThemeVariable } from './styles.js';

/**
 * The value of a theme variable at the UI layer in `container` (what controls draw on the map, which CSS cannot style:
 * F429), or the light theme's default before the layer is styled.
 */
export function themeValue(container: HTMLElement, name: ThemeVariable): string {
  const layer = container.querySelector('.vg-ui');
  const value = layer === null ? '' : getComputedStyle(layer).getPropertyValue(name).trim();
  return value === '' ? THEME_VARIABLES.light[name] : value;
}
