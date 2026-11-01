# 0185. No adapter of a paid or proprietary provider; applications connect them through the generic sources

- Status: Accepted
- Date: 2026-11-01
- Milestone: M7, M8, M9, M13 (F679; supersedes F256–F262, F321–F323, F340, F470, F549, F572, F573)

## Context

An audit of the maps the library connects (owner, 2026-11-01) found every default source open for commercial use, and
two kinds of code that serve no default: the Google Maps Platform adapters (2D tiles, Street View, Photorealistic 3D
Tiles; ADR 0031, ADR 0141) and the pipeline's Sentinel-2 cloudless reader, whose only accepted edition (2016) no build
used and whose commercial terms EOX now reserves to its commercial licence. The owner asked to remove both and to stay
compatible with any map: an application that wants Google connects it from its own code.

## Options

1. Keep the Google adapters as an optional, opt-in part of `@vibeglobe/sources`.
2. Remove them and keep only the generic mechanisms a provider's terms need.

## Decision

Option 2. The library ships no adapter of a paid or proprietary provider:

- `@vibeglobe/sources` loses `googleImagery`, `googleProfile`, `followGoogleCopyrights`, `googleStreetView` and
  `google3dTiles`, with their fixtures, playground scenario, end-to-end specs and the Google steps of the live suite.
- What a provider's terms need stays generic: `xyzImagery`, `tiles3d` and the other adapters take a `transport` that
  adds keys and session tokens the engine never sees (`fetchTransport`), and a `ProviderProfile` declares the required
  credit and logo, `displayOnly` (pixel readback, tile data, elevation sampling and picking refused), the loading
  features it forbids, its concurrency and session renewal. The core enforces them for every source (F255, F326, F679).
- The sources guide shows an application connecting Google Map Tiles this way ("Commercial providers, from your own
  code"); the application reads the provider's terms and owns the key and the billing.
- The data pipeline no longer reads Sentinel-2 cloudless: `s2cloudless` sources and the `s2cloudless-2016` profile are
  removed, and a source URL naming any edition is refused under the `eox-s2cloudless` profile (ADR 0025, amendment of
  2026-11-01). The license gate still refuses Google and the public OpenStreetMap tile servers as sources of a build.

## Consequences

- The superseded entries and their replacement F679 are listed in `docs/feature-changes.md`; the removed tests in
  `docs/test-changes.md`.
- ADR 0031's reading of Google's terms stays as a record an application can start from; its adapter settings no longer
  describe library code. ADR 0141's Google sessions are no longer library code either.
- F471's step with Google Photorealistic 3D Tiles "where a key is available" now means an application's own source.
- The pipeline's requester-pays pricing has no user left (`docs/follow-ups.md`).
