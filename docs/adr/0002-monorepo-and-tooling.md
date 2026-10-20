# 0002. Monorepo and tooling

- Status: Accepted (amended by 0015)
- Date: 2026-10-20
- Milestone: M1

## Context

`PLAN.md` asks for a TypeScript (strict, ESM) monorepo with separately consumable packages, tests, a playground and automated browser tests. Session 1 needs a working skeleton so that `init.sh` can install, build, start the playground and run the tests. Tool versions as of 2026-10-20: Node 22.22, npm 10.9, TypeScript 7.0.2 (native compiler) and 6.0.3, Vite 8.3, Vitest 5.0, Playwright 1.64.

## Options considered

1. **Package manager:** npm workspaces vs pnpm. pnpm has stricter dependency isolation and faster installs; npm ships with Node, needs no extra tool on the owner's machines or CI, and the owner's commands use npm (`npm run status`).
2. **TypeScript version:** 7.0 (native, much faster) vs 6.0 (last JavaScript-based compiler). typescript-eslint 8.72 supports `<6.1.0`, TypeDoc 0.28 supports up to `6.0.x`; both are needed in M1 for the no-`any` rule and the API reference.
3. **Library builds:** `tsc -b` with project references vs a bundler in library mode. `tsc` emits clean ESM and declarations with no extra tool; a bundler may become necessary for workers and shader assets (revisited in M1/M3).
4. **Tests:** Vitest (native ESM and TypeScript, shares Vite config) vs Jest. **Browser automation:** Playwright (Chromium, Firefox, WebKit; routing and throttling for network scenarios) vs WebdriverIO.
5. **Running TypeScript tooling scripts:** Node's built-in type stripping (Node ≥ 22.18) vs `tsx`/`ts-node`.

## Decision

- npm workspaces: `packages/*` for libraries, `apps/*` for the playground, docs site and examples.
- TypeScript pinned to 6.0.3 until typescript-eslint and TypeDoc support 7.x; then upgrade in its own ADR.
- Libraries build with `tsc -b` (ESM + `.d.ts` + maps); apps build with Vite. Workspace packages expose a `source` export condition so the playground and tests run on TypeScript sources with no prior build.
- Vitest for unit and integration tests (`vitest.config.ts` projects per package); Playwright for end-to-end, visual and scenario tests (`e2e/`).
- Tooling scripts are TypeScript run directly by Node (`engines.node >= 22.18.0`).
- Exact versions for every dependency (`save-exact`), with `package-lock.json` committed; `engine-strict` on.
- Package scope `@vibeglobe/` (registry scope tracked in `docs/open-questions.md`).
- `VIBEGLOBE_CHROMIUM_PATH` lets Playwright use a preinstalled Chromium (cloud containers ship one under `/opt/pw-browsers`); verified that Playwright 1.64 drives that build for the smoke test.

## Consequences

- No phantom-dependency protection from pnpm: every package must declare what it imports (to be enforced by the M1 dependency-rule check).
- `tsc -b` must be revisited if worker or shader assets need bundling.
- Upgrading TypeScript to 7.x is a tracked follow-up once the linting and documentation tools support it.

## Update 2026-10-20

The owner settled the registry: the `@vibeglobe/` scope is published on the public npm registry under the owner's `vibeglobe` organization, and the project is now named VibeGlobe (root package `vibeglobe`, environment variables `VIBEGLOBE_*`). Every `package.json` declares `PolyForm-Noncommercial-1.0.0`, checked by `npm run check` ([ADR 0015](0015-owner-decisions-2026-10-20.md), decisions 1 and 7).
