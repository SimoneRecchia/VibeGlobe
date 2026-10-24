# 0043. License: Mozilla Public License 2.0, contributions with a DCO sign-off

- Status: Accepted
- Date: 2026-10-24
- Milestone: M15 (applies to every milestone; supersedes the license part of ADR 0015, item 7)

## Context

Since ADR 0015 (2026-10-20) VibeGlobe was source-available under the PolyForm Noncommercial License 1.0.0. Commercial use needed a separate license from the owner, and external contributions needed a contributor license agreement (`CLA.md`) so they could be offered under both. On 2026-10-24 the owner decided to make VibeGlobe open source under the Mozilla Public License 2.0, with no commercial license, and to replace the CLA with a Developer Certificate of Origin sign-off. The owner also gave the contact address for security and code-of-conduct reports (open question 14). `PLAN.md` still names the former license; this ADR is the current decision.

## Options considered

1. **MPL-2.0** (the owner's choice): file-level copyleft. Changes to VibeGlobe's own files stay open, and applications built on it keep any license.
2. Keeping PolyForm Noncommercial with commercial licenses on request: the arrangement being replaced.

## Decision

- `LICENSE.md` in the root and in every package is the official MPL-2.0 text (Mozilla's text, from the Debian `common-licenses` copy, which keeps Mozilla's layout). Every `package.json` declares `"license": "MPL-2.0"`, and `npm run check` requires it. The release tarball check and the release assets declare it too.
- Every distributed source file under `packages/*/src` opens with the MPL Exhibit A notice, as the license recommends; `npm run check` requires it (after a shebang line; `.vue` files use an HTML comment). Tests, declarations and fixtures are not distributed and carry none.
- The README, the integration guide (the docs site), `CONTRIBUTING.md`, `CLAUDE.md` and the pull request template describe MPL-2.0. The commercial-license issue template is removed.
- `CLA.md` is removed. `DCO.md` holds the Developer Certificate of Origin 1.1, and every external commit carries `Signed-off-by:` (`git commit -s`).
- Security and code-of-conduct reports go to recchia.sim@gmail.com (`SECURITY.md`, `CODE_OF_CONDUCT.md`, README), or to GitHub's private vulnerability reporting.
- **Dependency compatibility.** The license audit keeps its allowlist (MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, and OFL-1.1 for fonts). Each of these may be distributed inside an MPL-2.0 project as long as its own notices travel with it, which `THIRD_PARTY_NOTICES.md` does.

## Consequences

- The entries that required the noncommercial license, the CLA or the commercial-license contact are `superseded`: F543, F544, F556, F557, F560 and F561. New entries F566–F571 carry the same requirements under MPL-2.0 (`docs/feature-changes.md`).
- Open question 13 (the legal review) now covers only the README licensing text; question 14 is answered.
- Verified by `npm run check` (license field and notices), `npm run licenses` (the audit) and the release tarball check.
