# Custom layer example

A layer type written as an application would write it (F388): beacons implemented against the public layer plug-in interface of `@vibeglobe/layers` (`Layer`, `LayerContext`, `FrameContext`, `packPickId`) and the render-target types of `@vibeglobe/core`, outside `packages/`.

## Rules

- Public API only: import from `@vibeglobe/layers` and `@vibeglobe/core` entry points, never from their `src` files; strict TypeScript, no `any`.
- The playground shows it with `?scenario=data-custom`; `e2e/custom-layer.spec.ts` checks drawing, picking, clicks and frame events.

## Commands

- `npm run build` (root) type-checks it with the other projects (`tsc -b`); it has no build output of its own.
