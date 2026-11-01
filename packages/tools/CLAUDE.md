# @vibeglobe/tools

Node command-line tools: the dataset pipeline, the offline package builder, license records.

## Rules

- Runs in Node only (no DOM lib). Every output records its sources' license and attribution; refuse sources whose terms forbid packaging.

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/internal/plan/architecture.md` for where this package fits.
