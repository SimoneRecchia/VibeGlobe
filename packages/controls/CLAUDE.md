# @vibeglobe/controls

Pointer, wheel, touch and keyboard input, gesture recognizers, inertia and navigation logic driving the core camera API.

## Rules

- All motion is time-based (frame-rate independent); any input interrupts animations from the applied camera without a jump.
- The tilt policy is shared with the engine through `NavigationApi.tiltPolicy` (a `Float64Array`): `[0]` lock, `[1]` auto-tilt start, `[2]` auto-tilt maximum (rad), `[3]` availability and `[5]` the frame's largest tilt (rad), both written by the engine, `[4]` the octaves from the lock to the full tilt (written here, 0 meaning 1). `controls.maxTiltDeg` reads `[5]`.

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/plan/architecture.md` for where this package fits.
