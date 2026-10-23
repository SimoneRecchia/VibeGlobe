// The feature groups of PLAN.md, from "Map experience" to "Security", each with a page of the example (F488).

/** A feature group's page. */
export interface FeatureGroup {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
}

export const FEATURE_GROUPS: readonly FeatureGroup[] = [
  {
    id: 'map-experience',
    title: 'Map experience',
    summary: 'Globe, 2D and 3D view modes and the globe-to-flat morph.',
  },
  { id: 'navigation', title: 'Navigation and controls', summary: 'Flights, fitting bounds and the zoom control.' },
  { id: 'rendering', title: 'Rendering and visual quality', summary: 'Complete frames and the resolution scale.' },
  { id: 'tiles', title: 'Tiles, level of detail and streaming', summary: 'Tiles streamed for the view.' },
  { id: 'sources', title: 'Map sources', summary: 'An application adapter, its credits and layer looks.' },
  { id: 'offline', title: 'Offline, online and caching', summary: 'Network modes and the tile tiers.' },
  { id: 'data-layers', title: 'Data layers', summary: 'Points and markers declared as components.' },
  { id: 'gis', title: 'GIS utilities', summary: 'Coordinate formats, measurement and view state in URLs.' },
  { id: 'ui', title: 'UI, accessibility and internationalization', summary: 'Ready-made controls and languages.' },
  { id: 'debugging', title: 'Debugging and diagnostics', summary: 'Phase timing, frame counters and resources.' },
  { id: 'security', title: 'Security and licensing', summary: 'No request without configuration, CSP-safe styles.' },
];
