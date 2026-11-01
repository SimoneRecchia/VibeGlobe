# Writing the guides

The guides in `docs/guides/` are read mostly by AI agents that write applications on VibeGlobe, from GitHub or from
`node_modules/@vibeglobe/core/docs/`, and by people second. An agent reads a guide to do one task: it needs the right
API names, a working example and the rules that make the result correct, in that order, and nothing it has to filter
out. These rules keep every guide that way; `scripts/integration/guides.test.ts` checks the parts a test can check.

## What goes where

| Where                                        | What                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `llms.txt`                                   | The index: one line per guide, saying which task it answers                   |
| `README.md`                                  | What VibeGlobe is, install, the smallest globe, the packages, the guides      |
| `packages/<name>/README.md`                  | What the package does, its entry points, one example, its pitfalls, its guide |
| `docs/guides/<topic>.md`                     | One topic an application meets, completely                                    |
| TSDoc in the sources                         | Every public name: what it is, units, default, what it throws                 |
| `docs/internal/` (ADRs, logs, plans, guides) | How and why the library is built; never needed to use it                      |

A fact lives in one place. The TSDoc owns signatures and per-option details; a guide owns how the pieces fit, the
order of calls, the defaults that matter and the pitfalls; a README points to the guide. Repeat a fact only as a link.

## The shape of a guide

```markdown
---
title: <Topic>
---

# <Topic>

<Two to four sentences: what this does, with which packages and entry points, when to use it, and what to use
instead for the neighbouring tasks (links).>

## Quick start

<The smallest complete example that works, then one sentence on what it shows.>

## <One section per task or concept, in the order an application meets them>

## Options

| Option | Type | Default | Effect |

## Rules and pitfalls

- <One rule per bullet, stated as a fact: "X must …", "Y is ignored when …", with the reason in a clause.>

## Errors

| Error or code | When | What to do |

## See also
```

Leave out a section the topic does not need (a guide without options has no "Options"). Long topics split into
sections, not into prose: an agent jumps to the heading it needs.

## How to write

- Exact names in backticks, as they are exported: `europeOpen`, `GlobeOptions.baseImageryUrl`, `@vibeglobe/presets`.
  Never a paraphrase of a name.
- Short declarative sentences in the present tense. One statement per sentence. Units in the words: "in metres",
  "levels 3 to 8", "from level 12 on".
- State defaults and limits as numbers, and say what happens at the edge ("above level 19 the tile is magnified").
- No history: no feature, bug or ADR numbers (F684, KB-322, ADR 0182), no "owner, date", no "now", "new" or "no
  longer". The guide describes the library as it is. Why a rule exists is a clause in the rule, not a story; the full
  reasoning stays in the ADR, linked from `docs/internal/` when it matters to a contributor.
- Table cells stay short (under about 120 characters); anything longer is a list or a paragraph.
- Examples are TypeScript blocks marked `ts` and compile as written: imports included, application values either
  declared (`declare const plants: Plant[];`) or among the test's preamble (`container`, `renderer`, `customerKey`).
  A block that only shows a shape or an output is marked `text`, `json` or `sh`.
- Links work where the document is read. The guides, `docs/data-licenses.md` and `llms.txt` travel in
  `@vibeglobe/core` and each package README in its package: between the guides, the data licenses and the index link
  by relative path; to anything else by its GitHub URL (`https://github.com/SimoneRecchia/VibeGlobe/blob/main/…`).
  Link internal documents only when a contributor needs them.

## Checks

- `scripts/integration/guides.test.ts`: every `ts` block of every guide type-checks against the packages' sources,
  every relative link of the public documentation leads to a file, and `llms.txt` lists every guide.
- `scripts/integration/europe-preset-guide.test.ts` and `sources-guide.test.ts`: the sections those guides must keep;
  the sources guide's examples also run.
