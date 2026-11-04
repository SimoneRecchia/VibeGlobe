# 0188. No consumer application named in the repository

- Status: Accepted
- Date: 2026-11-04
- Milestone: M15 (F559; an exception to ADR 0003)

## Context

The owner's brief of 2026-11-04: the library refers to no application that uses it, anywhere in the repository. Its
first consumer was still named in the owner's brief (`PLAN.md`), the architecture plan, eight feature entries, the
release checks that make sure nothing depends on it (F559 and the dependency rules), their tests and a few internal
notes. A check that looks for a name has to know it, and ADR 0003 forbids rewording a feature entry.

## Decision

- `PLAN.md`, the architecture plan and the notes speak of consumer applications, naming none.
- The checks keep the consumers' names only as SHA-256 hashes (`scripts/release/check-consumer-names.ts`): the release
  check hashes every word of every tracked text file, and the dependency rule every part of every dependency's name,
  and compares. Their tests use stand-in names. A word followed by "map" or "maps" is a texture's name and is skipped.
- The eight feature entries that named the consumer are reworded without changing what they require, by the owner's
  decision: `docs/internal/feature-redactions.md` lists them, and `npm run check:features` accepts their new wording
  and still rejects any other change to them.
- The test-changes log may name a removed test by the hash of its title (`sha256:<hex>`), for a title that named what
  the repository must not name.

## Consequences

- `node scripts/release/check-consumer-names.ts` finds no name in the tracked files; it reads every text file (about
  1,800, 57 MB) instead of those a search for the name found.
- The git history keeps the old texts: rewriting it would need a force push, which the owner has not asked for.
