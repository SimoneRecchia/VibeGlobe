# @vibeglobe/controls

Pointer, wheel, touch and keyboard input, gesture recognizers, inertia and navigation logic driving the core camera API.

## Rules

- All motion is time-based (frame-rate independent); any input interrupts animations from the applied camera without a jump.

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/plan/architecture.md` for where this package fits.
