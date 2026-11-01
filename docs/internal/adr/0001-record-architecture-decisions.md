# 0001. Record architecture decisions

- Status: Accepted
- Date: 2026-10-20
- Milestone: M1

## Context

`PLAN.md` requires every significant decision to be recorded with its context, the options considered, the decision and its consequences, so that later sessions (human or Claude) do not reopen settled questions by accident and can see why the code is the way it is.

## Options considered

1. **Lightweight ADRs in the repository (Markdown, one file per decision):** versioned with the code, reviewable in pull requests, readable by agents.
2. **Decisions in an external wiki or issue tracker:** invisible to a fresh session that only has the repository.
3. **Decisions only in commit messages:** hard to find and impossible to supersede cleanly.

## Decision

Option 1, in `docs/internal/adr/`, following the conventions in `docs/internal/adr/README.md` and the template `0000-template.md`.

## Consequences

Each significant decision costs a short document. Performance decisions must include their measurements, and provider-profile decisions must record the reading of the provider's terms at that date.
