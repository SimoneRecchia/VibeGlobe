# Contributing to VibeGlobe

Thank you for helping. VibeGlobe is built to a strict plan ([PLAN.md](PLAN.md)): zero visible glitches and extreme performance come first, then compatibility, then generality, then feature breadth.

## Before you start

- **Contributor license agreement:** every external pull request must include the acceptance line of the [CLA](CLA.md), so that the contribution can be offered under both the [PolyForm Noncommercial License](LICENSE.md) and the owner's commercial licenses. Pull requests without it are not reviewed.
- **Code of conduct:** everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
- **Security issues** are never reported in public issues: follow [SECURITY.md](SECURITY.md).
- **Bigger changes:** open an issue first. Work that `PLAN.md` does not ask for goes to `docs/follow-ups.md`, not into the code.

## Setup and everyday commands

Node.js 22.18 or later. `./init.sh` installs, builds, starts the playground and runs every test. The commands are listed in [CLAUDE.md](CLAUDE.md) and the [development guide](docs/guides/development.md).

## Rules that pull requests must follow

- **Feature list:** `feature_list.json` entries are never deleted, reordered or reworded; only their status changes ([ADR 0003](docs/adr/0003-session-state.md), [ADR 0016](docs/adr/0016-superseded-feature-entries.md)).
- **Tests:** never remove, skip or weaken a test, and never loosen `quality/*.json`. A genuinely wrong test is fixed with its reason in `docs/test-changes.md`.
- **Bugs:** list the bug in `docs/known-bugs.md` and start the fix with a failing regression test.
- **Code:** TypeScript strict, ES modules, no `any`, TSDoc on public APIs, units in names; small focused modules; English everywhere.
- **Third-party code:** permissive licenses only (MIT, BSD, Apache-2.0, ISC; OFL for fonts). Never copy code from other engines: study them, then write original code.
- **Decisions:** significant decisions are recorded as ADRs in `docs/adr/`.

## Submitting

1. Run `npm run verify` and the end-to-end tests (`npm run test:e2e`) locally.
2. Open a pull request with a clear description, the CLA acceptance line, and the feature-list entries it affects.
3. CI runs the fast checks on every push and pull request; the end-to-end tests and benchmarks run on `main` and nightly. A maintainer may run the full suite on your branch before merging.

## Questions

Open an issue with the question template.
