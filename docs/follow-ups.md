# Follow-up ideas

Ideas beyond `PLAN.md`'s scope go here, not into the code (`PLAN.md`, Working method: Scope). Each entry: the idea, why it could matter, and where it came from.

| Idea | Why | Source |
| --- | --- | --- |
| Upgrade to TypeScript 7 (native compiler) | Much faster type checks | ADR 0002, once typescript-eslint and TypeDoc support it |
| In-browser area builder for offline packages (estimate, license check, resume) | Lets device-mode apps build packages without the CLI; `PLAN.md` puts the builder in the CLI tools and the package API only installs, lists, updates and removes | Feature-list review, session 1 |
| Fresher imagery mosaic from raw Copernicus Sentinel-2 data | Newer imagery than the 2016 cloudless mosaic; `PLAN.md` marks it optional and it is a large remote-sensing job (cloud masking, mosaicking) | Feature-list review, session 1 |
| OpenStreetMap raster tiles from the pipeline | `PLAN.md` says "if useful"; needs a server-side renderer and a style | Feature-list review, session 1 |
