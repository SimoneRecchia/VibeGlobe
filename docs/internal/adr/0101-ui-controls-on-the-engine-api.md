# 0101. UI controls on the engine's public API: shared layers, the attribution, drawing input and the audit engine

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-23
- Milestone: M12

## Context

Track A builds the remaining M12 controls (F406–F417, F421–F426, F434–F437) in `@vibeglobe/ui` while the main session
works on the engine. The controls may use the engine and the data layers only through their public APIs
(`docs/internal/parallel-tracks.md`). Four questions came up that the existing ADRs do not settle.

## Decisions

1. **One data-layer stack per UI.** Controls that draw (geolocation, drawing, measurement) get their layers from
   `ControlContext.layers()`: the application's `createGlobeLayers` stack when it passes one in `UiOptions.layers`,
   else a single stack the UI creates on first use, loading `@vibeglobe/layers` only then. Two stacks on one renderer
   target would hand out colliding pick ids. The layer switcher lists only the stack the application gives it.
2. **Attribution beside the engine's element.** The engine always shows its own attribution element (F255), pinned to
   the container's bottom right. The `AttributionControl` lists `Globe.credits()` (updated on `credits-change`, which
   comes with the frame whose sources changed), collapses on narrow maps to the required credits and an expand button,
   and the UI layer keeps both bottom corners above the engine's element (`--vg-credits-height`, measured with a
   `ResizeObserver`). Until the engine can leave the attribution to an application control (track A's hook request 1),
   both lists show.
3. **Drawing input ahead of the controls.** The drawing tools listen on the map container in the capture phase. A tap
   is passed through (a press and release in place neither pans nor zooms); the second tap of a double tap, and a
   press on an edit handle or a shape, are kept from the navigation controls, so finishing a line never zooms and
   editing never pans, while a drag elsewhere still pans the map. Hit tests run in screen space on `geoToScreen`, so
   they need no id-buffer read. The keyboard drives a cursor over the map.
4. **Accessibility audit with the IBM Equal Access engine.** F434 asks for an automated audit such as axe-core, but
   axe-core is MPL-2.0, outside the permissive licenses CLAUDE.md allows. `accessibility-checker-engine` (Apache-2.0,
   W3C ACT-harmonized rules) runs the `WCAG_2_1` rule set on the UI layer in the browser (`e2e/ui-a11y-layout.spec.ts`);
   it is a development dependency only.

## Consequences

- Applications that already use data layers pass their stack to `createUi`; otherwise the UI's own stack serves.
- The duplicated credit list goes away when hook request 1 lands; the layout checks (F437) already treat both lists as
  the attribution no control may cover.
- A future application gesture on the container in the capture phase must coexist with the drawing tools' listeners.
