// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The ui package's stylesheet. Every color, font and size comes from a documented CSS variable ({@link THEME_VARIABLES}),
 * so an application restyles every control by setting variables on the `.vg-ui` element, in a rule of its own
 * stylesheet (`.vg-ui { --vg-ui-color: … }`, which wins in either theme: the defaults sit in the `vibeglobe-ui-theme`
 * cascade layer) or inline; internal selectors are not part of the API.
 */

/** Names of the theme's CSS variables. */
export type ThemeVariable = keyof typeof LIGHT;

/** The light theme's values, the defaults. */
const LIGHT = {
  /** Font of every control. */
  '--vg-ui-font-family': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  '--vg-ui-font-size': '13px',
  /** Font of the debug panel's figures. */
  '--vg-ui-monospace-font-family': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  /** Text and icon color. */
  '--vg-ui-color': '#1b1f24',
  /** Secondary text (labels, hints). */
  '--vg-ui-muted-color': '#4d5560',
  /** Control and panel background. */
  '--vg-ui-background': '#ffffff',
  /** Background of a hovered or pressed button. */
  '--vg-ui-hover-background': '#e6e9ee',
  '--vg-ui-border-color': '#6b7380',
  '--vg-ui-border-width': '1px',
  '--vg-ui-border-radius': '6px',
  /** North needle of the compass and other highlights. */
  '--vg-ui-accent-color': '#b3261e',
  /** Keyboard focus ring. */
  '--vg-ui-focus-color': '#0b57d0',
  '--vg-ui-focus-width': '3px',
  /** Side of square buttons; touch screens use at least `--vg-ui-touch-size`. */
  '--vg-ui-button-size': '36px',
  '--vg-ui-touch-size': '44px',
  '--vg-ui-icon-size': '20px',
  /** Gap between controls and from the map's edges. */
  '--vg-ui-spacing': '8px',
  '--vg-ui-shadow': '0 1px 4px rgba(0, 0, 0, 0.35)',
  '--vg-ui-panel-width': '280px',
  '--vg-ui-disabled-opacity': '0.4',
  /** Duration of UI transitions; 0s when the system asks for reduced motion. */
  '--vg-ui-transition-duration': '150ms',
  /** The debug panel: light text on a translucent dark backing in both themes, readable over any imagery. */
  '--vg-ui-debug-color': '#ffffff',
  '--vg-ui-debug-background': 'rgba(0, 0, 0, 0.75)',
  '--vg-ui-debug-font-size': '12px',
  /** What controls draw on the map, read when they draw it: the geolocation marker and its accuracy circle. */
  '--vg-ui-marker-color': '#1a73e8',
  '--vg-ui-marker-outline-color': '#ffffff',
  /** Drawn and measured shapes, and the fill of their edit handles. */
  '--vg-ui-drawing-color': '#d93025',
  '--vg-ui-drawing-handle-color': '#ffffff',
  /** The minimap's view footprint (its fill is the same color, translucent). */
  '--vg-ui-minimap-footprint-color': '#ff4040',
} as const;

/** The dark theme's values. */
const DARK: Readonly<Record<ThemeVariable, string>> = {
  ...LIGHT,
  '--vg-ui-color': '#f1f3f7',
  '--vg-ui-muted-color': '#b9c0cc',
  '--vg-ui-background': '#1f232b',
  '--vg-ui-hover-background': '#323844',
  '--vg-ui-border-color': '#8d95a3',
  '--vg-ui-accent-color': '#f28b82',
  '--vg-ui-focus-color': '#8ab4f8',
  '--vg-ui-shadow': '0 1px 4px rgba(0, 0, 0, 0.7)',
};

/** Built-in themes. */
export type ThemeName = 'light' | 'dark';

/** Every documented theme variable with its value in each built-in theme. */
export const THEME_VARIABLES: Readonly<Record<ThemeName, Readonly<Record<ThemeVariable, string>>>> = {
  light: LIGHT,
  dark: DARK,
};

function declarations(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}:${value};`)
    .join('');
}

/**
 * The theme blocks: the only place where literal colors, fonts and sizes appear. In a cascade layer, so any rule of the
 * page's own stylesheets overrides them (KB-165); reduced motion overrides both themes (KB-164).
 */
export const THEME_CSS =
  '@layer vibeglobe-ui-theme{' +
  // A debug panel outside a UI layer (the playground's) takes the defaults itself; inside one it inherits the layer's.
  `.vg-ui,.vibeglobe-debug-overlay:not(.vg-ui .vibeglobe-debug-overlay){${declarations(LIGHT)}}` +
  `.vg-ui[data-theme="dark"]{${declarations(DARK)}}` +
  '@media (prefers-reduced-motion: reduce){.vg-ui,.vg-ui[data-theme]{--vg-ui-transition-duration:0s;}}}';

/** The rules of every control: values come from the theme variables only (F429, checked by styles.test.ts). */
export const RULES_CSS = `
.vg-ui{position:absolute;inset:0;pointer-events:none;font-family:var(--vg-ui-font-family);font-size:var(--vg-ui-font-size);color:var(--vg-ui-color);z-index:1}
.vg-ui *{box-sizing:border-box}
.vg-ui [hidden]{display:none !important}
.vg-ui__corner > *{pointer-events:auto}
.vg-ui__corner{position:absolute;display:flex;flex-direction:column;gap:var(--vg-ui-spacing);padding:var(--vg-ui-spacing);max-width:100%}
.vg-ui__corner--top-left{top:0;left:0;align-items:flex-start}
.vg-ui__corner--top-right{top:0;right:0;align-items:flex-end}
.vg-ui__corner--bottom-left{bottom:0;left:0;align-items:flex-start;flex-direction:column-reverse}
.vg-ui__corner--bottom-right{bottom:0;right:0;align-items:flex-end;flex-direction:column-reverse}
.vg-ui__control{pointer-events:auto;display:flex;flex-direction:column;background:var(--vg-ui-background);border:var(--vg-ui-border-width) solid var(--vg-ui-border-color);border-radius:var(--vg-ui-border-radius);box-shadow:var(--vg-ui-shadow)}
.vg-ui__button{display:flex;align-items:center;justify-content:center;width:var(--vg-ui-button-size);height:var(--vg-ui-button-size);padding:0;margin:0;border:0;border-radius:var(--vg-ui-border-radius);background:var(--vg-ui-background);color:var(--vg-ui-color);font:inherit;cursor:pointer;touch-action:none;transition:background-color var(--vg-ui-transition-duration)}
.vg-ui__button:hover:not(:disabled){background:var(--vg-ui-hover-background)}
.vg-ui__button:disabled{opacity:var(--vg-ui-disabled-opacity);cursor:default}
.vg-ui__button svg{width:var(--vg-ui-icon-size);height:var(--vg-ui-icon-size);fill:currentColor}
.vg-ui__button + .vg-ui__button{border-top:var(--vg-ui-border-width) solid var(--vg-ui-border-color);border-top-left-radius:0;border-top-right-radius:0}
.vg-ui__control > .vg-ui__button:not(:last-child){border-bottom-left-radius:0;border-bottom-right-radius:0}
.vg-ui :focus-visible{outline:var(--vg-ui-focus-width) solid var(--vg-ui-focus-color);outline-offset:var(--vg-ui-border-width);box-shadow:0 0 0 calc(var(--vg-ui-focus-width) * 2) var(--vg-ui-background)}
.vg-ui__compass-needle{transform-origin:center;transform-box:fill-box}
.vg-ui__compass-north{fill:var(--vg-ui-accent-color)}
.vg-ui__readout{flex-direction:row;align-items:center;gap:var(--vg-ui-spacing);padding-left:var(--vg-ui-spacing);font-variant-numeric:tabular-nums}
.vg-ui__readout-text{display:flex;flex-direction:column;white-space:nowrap}
.vg-ui__readout-detail{color:var(--vg-ui-muted-color)}
.vg-ui__search{width:var(--vg-ui-panel-width);max-width:100%}
.vg-ui__search-input{width:100%;min-height:var(--vg-ui-button-size);padding:0 var(--vg-ui-spacing);border:0;border-radius:var(--vg-ui-border-radius);background:var(--vg-ui-background);color:var(--vg-ui-color);font:inherit}
.vg-ui__search-input::placeholder{color:var(--vg-ui-muted-color);opacity:1}
.vg-ui__search-list{list-style:none;margin:0;padding:0;border-top:var(--vg-ui-border-width) solid var(--vg-ui-border-color)}
.vg-ui__search-list:empty{display:none}
.vg-ui__search-option{padding:var(--vg-ui-spacing);cursor:pointer;min-height:var(--vg-ui-button-size)}
.vg-ui__search-option[aria-selected="true"],.vg-ui__search-option:hover{background:var(--vg-ui-hover-background)}
.vg-ui__search-status{padding:0 var(--vg-ui-spacing);color:var(--vg-ui-muted-color)}
.vg-ui__search-status:empty{display:none}
.vibeglobe-debug-overlay{position:absolute;top:var(--vg-ui-spacing);left:var(--vg-ui-spacing);padding:calc(var(--vg-ui-spacing) / 2) var(--vg-ui-spacing);border-radius:var(--vg-ui-border-radius);font-family:var(--vg-ui-monospace-font-family);font-size:var(--vg-ui-debug-font-size);line-height:1.4;color:var(--vg-ui-debug-color);background:var(--vg-ui-debug-background);pointer-events:none;white-space:pre}
.vg-ui__corner .vibeglobe-debug-overlay{position:static}
.vg-ui__corner--bottom-left,.vg-ui__corner--bottom-right{padding-bottom:calc(var(--vg-ui-spacing) + var(--vg-credits-height))}
.vg-ui__segmented{display:flex;flex-direction:row}
.vg-ui__view-mode{flex-direction:row;align-items:stretch}
.vg-ui__button--text{width:auto;min-width:var(--vg-ui-button-size);padding:0 var(--vg-ui-spacing);font-weight:600}
.vg-ui__segmented .vg-ui__button + .vg-ui__button,.vg-ui__view-mode > .vg-ui__button{border-top:0;border-left:var(--vg-ui-border-width) solid var(--vg-ui-border-color);border-radius:0}
.vg-ui__segmented .vg-ui__button[aria-pressed="true"],.vg-ui__button--geolocate[aria-pressed="true"]{background:var(--vg-ui-color);color:var(--vg-ui-background)}
.vg-ui__segmented .vg-ui__button[aria-pressed="true"]:hover:not(:disabled),.vg-ui__button--geolocate[aria-pressed="true"]:hover:not(:disabled){background:var(--vg-ui-color)}
.vg-ui__tilt-track{position:relative;width:var(--vg-ui-button-size);height:calc(var(--vg-ui-button-size) * 3);cursor:ns-resize;touch-action:none;border-radius:var(--vg-ui-border-radius)}
.vg-ui__tilt-track::before{content:"";position:absolute;left:50%;top:var(--vg-ui-spacing);bottom:var(--vg-ui-spacing);border-left:calc(var(--vg-ui-border-width) * 2) solid var(--vg-ui-border-color)}
.vg-ui__tilt-thumb{position:absolute;left:20%;width:60%;height:var(--vg-ui-spacing);border-radius:var(--vg-ui-border-radius);background:var(--vg-ui-color);bottom:calc((100% - var(--vg-ui-spacing)) * var(--vg-tilt-fraction))}
.vg-ui__tilt-track[data-clamped="true"] .vg-ui__tilt-thumb{background:var(--vg-ui-accent-color)}
.vg-ui__scale{padding:calc(var(--vg-ui-spacing) / 2) var(--vg-ui-spacing);align-items:flex-start;font-variant-numeric:tabular-nums}
.vg-ui__scale-bar{height:var(--vg-ui-spacing);border:calc(var(--vg-ui-border-width) * 2) solid var(--vg-ui-color);border-top:0}
.vg-ui__attribution{flex-direction:row;align-items:center;max-width:100%}
.vg-ui__attribution-list{display:flex;flex-wrap:wrap;align-items:center;gap:var(--vg-ui-spacing);list-style:none;margin:0;padding:calc(var(--vg-ui-spacing) / 2) var(--vg-ui-spacing)}
.vg-ui__attribution-list:empty{display:none}
.vg-ui__attribution[data-expanded="false"] .vg-ui__credit:not(.vg-ui__credit--required){display:none}
.vg-ui__credit{display:flex;align-items:center;gap:calc(var(--vg-ui-spacing) / 2)}
.vg-ui__credit a{color:inherit}
.vg-ui__credit-logo{height:var(--vg-ui-icon-size)}
.vg-ui__panel{padding:var(--vg-ui-spacing);border-top:var(--vg-ui-border-width) solid var(--vg-ui-border-color);min-width:calc(var(--vg-ui-panel-width) / 2)}
.vg-ui__layers-group{border:0;margin:0;padding:0}
.vg-ui__layers-group legend{font-weight:600;padding:0}
.vg-ui__layers-item{display:flex;align-items:center;gap:var(--vg-ui-spacing);min-height:var(--vg-ui-button-size);cursor:pointer}
.vg-ui__bookmarks-form{display:flex;gap:var(--vg-ui-spacing);margin-bottom:var(--vg-ui-spacing)}
.vg-ui__text-input{flex:1;min-width:0;min-height:var(--vg-ui-button-size);padding:0 var(--vg-ui-spacing);border:var(--vg-ui-border-width) solid var(--vg-ui-border-color);border-radius:var(--vg-ui-border-radius);background:var(--vg-ui-background);color:var(--vg-ui-color);font:inherit}
.vg-ui__text-input::placeholder{color:var(--vg-ui-muted-color);opacity:1}
.vg-ui__bookmarks-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:calc(var(--vg-ui-spacing) / 2)}
.vg-ui__bookmark{display:flex;align-items:center;gap:calc(var(--vg-ui-spacing) / 2)}
.vg-ui__bookmark .vg-ui__button--bookmark-go{flex:1;justify-content:flex-start;font-weight:normal}
.vg-ui__bookmarks-empty{color:var(--vg-ui-muted-color)}
.vg-ui__minimap{overflow:hidden}
.vg-ui__minimap-canvas{display:block;border-radius:var(--vg-ui-border-radius)}
.vg-ui__draw-cursor{position:absolute;width:var(--vg-ui-button-size);height:var(--vg-ui-button-size);margin:calc(var(--vg-ui-button-size) / -2) 0 0 calc(var(--vg-ui-button-size) / -2);border-radius:50%;pointer-events:none;background:linear-gradient(var(--vg-ui-color),var(--vg-ui-color)) center / var(--vg-ui-border-width) 100% no-repeat,linear-gradient(var(--vg-ui-color),var(--vg-ui-color)) center / 100% var(--vg-ui-border-width) no-repeat}
.vg-ui__draw-cursor:not(:focus-visible){opacity:0}
.vg-ui__measure-tools{border:0;box-shadow:none}
.vg-ui__measure-readout{padding:0 var(--vg-ui-spacing);font-variant-numeric:tabular-nums}
.vg-ui__measure-readout:empty{display:none}
.vg-ui__status{padding:0 var(--vg-ui-spacing);color:var(--vg-ui-muted-color);max-width:var(--vg-ui-panel-width)}
.vg-ui__status:empty{display:none}
@media (pointer: coarse){.vg-ui__button,.vg-ui__search-option,.vg-ui__search-input,.vg-ui__tilt-track,.vg-ui__layers-item,.vg-ui__credit a,.vg-ui__scale,.vg-ui__text-input{min-width:var(--vg-ui-touch-size);min-height:var(--vg-ui-touch-size)}.vg-ui__credit a{display:inline-flex;align-items:center}}
`;
