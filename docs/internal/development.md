---
title: Development
---

# Development

How to build, test and change VibeGlobe. The rules behind this workflow are in `CLAUDE.md` and `PLAN.md`.

## Requirements

Node.js 22.18 or later (TypeScript tooling scripts run through Node's built-in type stripping) and npm.

## Everyday commands

| Command                               | What it does                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `./init.sh`                           | Install, build, start the playground, run unit and end-to-end tests, print feature status |
| `npm run dev`                         | Playground at http://localhost:5173                                                       |
| `npm test` / `npm run coverage`       | Unit tests; with coverage thresholds from `quality/coverage.json`                         |
| `npm run test:e2e`                    | Playwright tests against the playground and this documentation site                       |
| `npm run lint` / `npm run format`     | ESLint and Prettier                                                                       |
| `npm run verify`                      | Every check CI runs except the browser tests                                              |
| `npm run bench`                       | Benchmark scenarios against `quality/budgets.json` (needs `npm run build`)                |
| `npm run docs` / `npm run docs:serve` | Build and serve this site at http://localhost:5174                                        |
| `npm run status`                      | Feature-list progress                                                                     |

## Packages

Library packages live in `packages/<name>` and are published as `@vibeglobe/<name>`; apps live in `apps/`. Each package has its own `CLAUDE.md`. The architecture and dependency rules are in `docs/internal/plan/architecture.md`, and `npm run check` enforces the layout and dependency rules.

## Quality gates

Coverage minima (`quality/coverage.json`) and performance and bundle-size budgets (`quality/budgets.json`) are versioned. Loosening one, or removing a test, fails `npm run check:tests` unless the change is recorded with its reason in `docs/internal/test-changes.md`.
