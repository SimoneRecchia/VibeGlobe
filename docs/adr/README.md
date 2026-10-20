# Architecture Decision Records

Every significant decision is recorded here: context, options considered, decision, consequences. Performance decisions include the measurements behind them; provider-profile decisions record the reading of the provider's current terms.

Conventions:

- One file per decision, named `NNNN-short-title.md` with a four-digit sequence number. Copy [0000-template.md](0000-template.md).
- Status is one of `Proposed`, `Accepted`, `Superseded by NNNN`, `Deprecated`. Accepted ADRs are not rewritten: a changed decision gets a new ADR that supersedes the old one.
- Link the ADR from the code that implements a non-obvious decision, and from `docs/plan/` when it settles a decision marked Proposed there.

| ADR                                           | Title                                   | Status   |
| --------------------------------------------- | --------------------------------------- | -------- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions           | Accepted |
| [0002](0002-monorepo-and-tooling.md)          | Monorepo and tooling                    | Accepted |
| [0003](0003-session-state.md)                 | Session state for a multi-session build | Accepted |
