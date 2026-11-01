# Contributing to VibeGlobe

Thank you for helping. VibeGlobe is built to a strict plan ([PLAN.md](PLAN.md)): zero visible glitches and extreme performance come first, then compatibility, then generality, then feature breadth.

## Before you start

- **License and sign-off:** VibeGlobe is under the [Mozilla Public License 2.0](LICENSE.md), and contributions are accepted under it. Every commit carries a [Developer Certificate of Origin](DCO.md) sign-off (`git commit -s`, which adds `Signed-off-by: Your Name <email>`); pull requests with unsigned commits are not reviewed.
- **Code of conduct:** everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
- **Security issues** are never reported in public issues: follow [SECURITY.md](SECURITY.md).
- **Bigger changes:** open an issue first. Work that `PLAN.md` does not ask for goes to `docs/internal/follow-ups.md`, not into the code.

## Setup and everyday commands

Node.js 22.18 or later. `./init.sh` installs, builds, starts the playground and runs every test. The commands are listed in [CLAUDE.md](CLAUDE.md) and the [development guide](docs/internal/development.md).

## Rules that pull requests must follow

- **Feature list:** `feature_list.json` entries are never deleted, reordered or reworded; only their status changes ([ADR 0003](docs/internal/adr/0003-session-state.md), [ADR 0016](docs/internal/adr/0016-superseded-feature-entries.md)).
- **Tests:** never remove, skip or weaken a test, and never loosen `quality/*.json`. A genuinely wrong test is fixed with its reason in `docs/internal/test-changes.md`.
- **Bugs:** list the bug in `docs/internal/known-bugs.md` and start the fix with a failing regression test.
- **Code:** TypeScript strict, ES modules, no `any`, TSDoc on public APIs, units in names; small focused modules; English everywhere.
- **Third-party code:** permissive licenses only (MIT, BSD, Apache-2.0, ISC; OFL for fonts). Never copy code from other engines: study them, then write original code.
- **License notice:** every new source file under `packages/*/src` opens with the MPL 2.0 notice (`npm run check`):

  ```ts
  // This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
  // distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
  ```

- **Decisions:** significant decisions are recorded as ADRs in `docs/internal/adr/`.

## Submitting

1. Run `npm run verify` and the end-to-end tests (`npm run test:e2e`) locally.
2. Open a pull request with a clear description and the feature-list entries it affects; every commit signed off.
3. CI runs the fast checks on every push and pull request; the end-to-end tests and benchmarks run on `main` and nightly. A maintainer may run the full suite on your branch before merging.

## Questions

Open an issue with the question template.
