---
name: dataset-build
description: Build, resume, verify and publish VibeGlobe's default datasets (terrain, imagery, fallback, OpenStreetMap vector tiles) with the vibeglobe-data pipeline in packages/tools. Use when asked to estimate, build, rebuild, resume, check or publish dataset tiles or offline packages, or to add a region.
---

# Dataset build

The pipeline is the `vibeglobe-data` command of `packages/tools` (ADR 0023). Every build is defined by a JSON configuration in `packages/tools/configs/` (`world-low.json`, `italy-high.json`, `test-mont-blanc.json`); licenses are in ADR 0024 and `docs/data-licenses.md`. Run every command from the repository root.

## 0. Prepare

```sh
npm run build                                  # builds packages/tools/dist
alias vibeglobe-data='node packages/tools/dist/bin.js'
vibeglobe-data help                            # commands and the datasets of each configuration
```

Real downloads cost the owner's time and, for Sentinel-2 cloudless, money (requester-pays). In a session without the owner's go-ahead, work on the configuration's sample area (`--sample`) and use the fixture server for sources that need credentials or that the network blocks (step 2).

## 1. Estimate (downloads nothing)

```sh
vibeglobe-data estimate italy-high.json            # the full region
vibeglobe-data estimate italy-high.json --sample   # the sample area only
```

It prints, per dataset and zoom level, the exact tile count (about 4× per added level), the bytes written, the files and bytes downloaded, and the cost at the per-GB prices recorded in the configuration with their reading date. Show this to the owner before any full build.

## 2. Build

```sh
vibeglobe-data build italy-high.json --sample
```

The estimate is printed first and the build waits for `yes`. Non-interactive runs (CI, scripts, agents) must add `--yes` after the estimate has been reviewed; without it they stop before any download. `--dataset terrain,imagery` restricts the datasets. The steps can also be run one at a time: `download`, `convert`, `tile`, `package` (each runs the earlier ones, which resume).

Without the owner's credentials or network access to a source, serve the fixture stubs and point the datasets at them:

```sh
vibeglobe-data fixtures serve --port 8710 &
vibeglobe-data build italy-high.json --sample --yes \
  --source-url imagery=http://127.0.0.1:8710/s2,vectors=http://127.0.0.1:8710/osm/italy.osm.pbf
```

With real Sentinel-2 cloudless access, set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the environment (never in a file) and pass `--source-url imagery=<bucket or mirror URL>` until the configuration names the new source (open question 21).

Outputs go to `packages/tools/node_modules/.vibeglobe-data/<config>[-sample]/` (ignored by git and the linters; `--out <folder>` chooses another folder):

- `output/<dataset>/{z}/{x}/{y}.<ext>` and `output/<dataset>/metadata.json`: the static folder;
- `output/<dataset>.pmtiles` (and `.mbtiles` when enabled): the packages;
- `output/fallback-base.jpg`: the global base image (world configuration);
- `downloads/`, `work/`, `steps/`: the resumable state. Keep them to resume or rebuild quickly.

## 3. Resume

Run the same command again. Completed downloads and tiles whose files still match their logged SHA-256 are skipped (`skip … (checksum verified)`, `z13: 34 tiles built, 30 skipped`); a partial download resumes with a range request; a corrupted download or tile is reported as `corrupt …` and regenerated. Nothing needs cleaning up after a kill.

## 4. Verify

- **Terrain against the source, with GDAL in the configuration's pinned Docker image** (needs Docker):
  `vibeglobe-data verify italy-high.json --sample --points 1000` must print `PASS` (give the same `--out` as the build if you chose one).
- **Licenses:** `vibeglobe-data licenses` lists every profile; every `metadata.json` carries `attribution`, `license`, `sources`, `dataYear`, `configVersion` and `pipelineVersion`.
- **Reproducibility:** a build of the same configuration in an empty folder gives byte-identical outputs: build twice with `--out /tmp/a` and `--out /tmp/b`, then `(cd /tmp/a/output && find . -type f | sort | xargs sha256sum) > a.sum`, the same for `b`, and `cmp a.sum b.sum`.
- **Size:** the output size should be within 30% of the estimate; when it is not, update the dataset's `bytesPerTile` in the configuration from the measured sample.
- **Tests:** `npx vitest run packages/tools` and, for the browser checks, `VIBEGLOBE_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test -c packages/tools/playwright.config.ts`.

## 5. Publish

The project runs no servers (ADR 0015): consumers publish the outputs on their own infrastructure, following `docs/guides/hosting.md` (static folders, PMTiles behind range requests, MIME types, CORS, caching, attribution). Copy `output/` to a versioned path, for example `tiles/italy-high-1.0.0/`, so tiles can be cached as immutable. Never commit outputs or downloads to the repository.

## Add a region

Copy a configuration, change `name`, `region` (a bounding box, or a GeoJSON polygon file next to it), `sampleArea` and the zoom ranges, then estimate and build it as above: no code changes. Pin `sourceVersion` for every dataset and keep `tools.gdal` pinned by digest; the validator rejects anything else.
