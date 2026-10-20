# VibeGlobeEngine — Master Plan

Oct 20, 2026 · @Simone

VibeGlobeEngine must be the most optimized, glitch-free web globe engine we can build: designed after studying every major open-source engine, tested on every supported system, and compatible with any map source.

## How to use this document

This is the master brief for VibeGlobeEngine: the implementing agent turns it into its own detailed technical plan, then builds everything in it, end to end.

1. Read the whole document before writing any code. Then write your own detailed implementation plan in the repository (for example under `docs/plan/`): architecture, modules, data structures, public APIs and a task breakdown.
2. The scope is everything in this document. Do not stop after a minimum viable product: complete every milestone until the Definition of done is met.
3. The Fixed constraints are mandatory. Everything else (libraries, algorithms, formats, file layout, tooling) is your decision. The recommendations here record what was learned while planning: follow them unless you find a better option, and record why. The reasons behind the owner's decisions are in the Decision log.
4. Record every significant decision as an Architecture Decision Record (for example `docs/adr/`): context, options considered, decision, consequences.
5. Before building each subsystem, complete the Research survey for that area: study how the best-known open-source engines solve the problem, including their issue trackers, tests and benchmarks. Then design a solution that matches or beats them. Never copy code from any project.
6. Verify each milestone against its acceptance criteria, with automated tests wherever possible, before moving on.
7. Keep the session state described in Working method (feature list, progress notes, git history) up to date, so work can resume after any interruption.
8. When blocked by something only the owner can provide (credentials, hosting, purchases, legal sign-off), write it in an open-questions file, use a stub or mock, and continue with the rest. Ask the owner only for decisions that are truly theirs.
9. Priorities, in order: zero visible glitches and extreme performance, then compatibility with every map and supported system, then generality and modularity, then feature breadth. A stutter, flicker, seam or inconsistency is a bug, not a polish item.

## Working method for a multi-session build

This project spans many sessions and context windows, so all state lives in files and git: any fresh session can pick up exactly where the last one stopped.

First session:

1. Read this whole document, then write your detailed technical plan in the repository.
2. Turn every requirement in this document into a structured feature list (for example `feature_list.json`): one entry per end-to-end behavior, with the steps that prove it and a status, all starting as failing. Afterwards only the status field changes; entries are never deleted or reworded to make progress look better.
3. Create progress notes (for example `progress.md`), an init script that installs, builds, starts the playground and runs the tests, a concise CLAUDE.md, and the first git commit.

Every later session:

1. Read the progress notes, the feature list and the recent git log, then run the init script.
2. Run a quick end-to-end check of the playground before starting new work; if something is broken, fix it first.
3. Pick the highest-priority failing feature and work on that one feature until it is done.
4. Prove it end to end the way a user would: in a real browser driven by automation, with screenshots for visual behavior, plus the automated tests. Mark it passing only then.
5. Commit with a descriptive message, update the progress notes, and leave the repository clean: it builds, the tests pass, and nothing half-done is left uncommitted.

Rules that hold throughout:

- **Tests protect the work:** never remove or weaken a test to make it pass, and solve problems generally rather than for specific test inputs. If a test is genuinely wrong, fix it and record why.
- **Context:** Claude Code compacts the conversation automatically. Keep state in files and git and keep working, rather than stopping early because a session has been long.
- **Autonomy:** proceed without asking for reversible actions within this plan's scope. Ask the owner first for destructive or externally visible actions: force pushes, deleting branches or data, publishing packages, changing repository settings.
- **Scope:** build what this plan specifies, completely. Ideas beyond it go into a follow-up list, not into the code.
- **Subagents:** use them for wide, independent work, such as surveying many repositories in parallel or running adapter conformance suites; do everything else directly.
- **Milestone review:** at the end of each milestone, not after every change, a reviewer in a fresh context checks the work against this plan and the milestone's acceptance criteria. It reports only correctness and requirement gaps, not style preferences, so the review does not push toward over-engineering.
- **Claude Code setup:** keep CLAUDE.md short (commands, conventions that differ from defaults, testing, architecture decisions, gotchas), with per-package files in the monorepo; use hooks for checks that must always run (format, lint, type check) and skills for occasional workflows (dataset builds, releases).

## Vision and goals

VibeGlobeEngine is a generic, modular web engine that renders an interactive 3D globe and map with the feel of Google Earth, Google Maps and Apple Maps, and it must be extremely optimized: visual quality and fluidity come before everything else.

- **What it is:** a TypeScript library for the browser. One continuous camera shows a 3D globe when zoomed out, a flat 2D map at mid zoom and an oblique 3D view up close.
- **Who uses it:** any web application. The first consumer is Vireox Cube, a commercial web platform (Vue/Nuxt, TypeScript) with a GIS module. The engine lives in its own repository and Cube consumes it later as a library. Nothing in the engine may depend on Cube.

Primary goals:

- **Fluidity:** zoom, pan, rotate, tilt and long flights run at a steady frame rate with no stutter or lag.
- **Visual quality:** never show black or empty areas, holes, seams, flicker, popping or jitter, at any zoom.
- **Online, offline and mixed:** works with no internet, on a slow link or a fast one, choosing what to load so motion stays smooth.
- **Map-agnostic:** any imagery, terrain or vector source can be attached through adapters.
- **Commercially redistributable:** everything shipped by default is free and licensed for commercial use.

Secondary goals: use only the modules you need, a framework-agnostic core with thin adapters, complete documentation, high test coverage.

Non-goals: a hosted map or tile service business, and native (non-web) apps.

## Fixed constraints

These decisions are final; the agent must not change them without the owner's approval.

| Area | Decision |
| --- | --- |
| Name | VibeGlobeEngine (repository and product name). Package names are lowercase; exact naming is the agent's choice. |
| Repository | Private GitHub repository, fully separate from Vireox Cube. |
| Language | TypeScript in strict mode, ES modules. Code, comments, documentation and commit messages in English. |
| Platforms | Every major operating system (Windows, macOS, Linux, ChromeOS, iPadOS, Android) in current browsers: Chrome, Edge, Firefox and Safari, current and previous major versions. Any GPU vendor. Desktop is the primary target; tablets with touch must be fully supported; phones are best effort. |
| Graphics | WebGPU as the primary backend, with an automatic WebGL2 fallback. Devices without WebGL2 are out of scope. |
| Core | Framework-agnostic: no dependency on Vue, Nuxt, React or Cube. Integrations are separate adapter packages; a Vue 3 adapter and a framework-neutral Web Component wrapper are required. |
| Server-side rendering | Importing any package must be safe under SSR (Nuxt): no access to window, document or the GPU at import time. |
| Network mode | Configurable: online only, offline only, or hybrid (both). Default: hybrid. |
| Cache | Every loading feature (persistent cache, memory reuse, prefetch and flight preloading, offline packaging) is enabled by default and can be disabled globally or per source. Built-in provider profiles for Google Maps Platform and OpenStreetMap switch off automatically what each provider's terms forbid. |
| Third-party code | Permissive licenses only (MIT, BSD, Apache-2.0, ISC; fonts under OFL). No GPL, LGPL, AGPL or other copyleft in anything shipped. No code copied from other engines: ideas are studied, implementations are original. |
| Default data | Only free sources licensed for commercial redistribution, self-hosted (see Default datasets). No default dependency on Google, Apple, Mapbox, MapTiler, Cesium ion or other paid or restricted services; they may exist only as optional adapters that respect their terms. |
| Geodesy | WGS84 ellipsoid for every position, measurement and computation, whatever the display projection. |
| Offline | Both offline modes are required: a local-network server with no internet, and a user device with no network. |

## Engineering standards: optimization, correctness, compatibility

Every part of the engine is written for maximum performance, zero visible defects and broad compatibility; these standards apply to every milestone and every line of code.

Extreme optimization:

- **Budgets:** CPU and GPU time budgets per frame and per feature, plus memory and bundle-size budgets per package, enforced by automated benchmarks. Breaking a budget is a bug.
- **Measure first:** profile before and after every optimization; record the measurements behind each performance decision in its ADR.
- **No garbage in hot paths:** per-frame code allocates nothing (pooled objects, preallocated typed arrays), so garbage collection never causes a stutter.
- **GPU efficiency:** minimal draw calls and state changes (batching, instancing, texture arrays or atlases, state sorting); no redundant uploads.
- **Free main thread:** decoding, parsing and mesh generation in workers; evaluate rendering from a worker (OffscreenCanvas) where supported.
- **Network efficiency:** compact binary formats, compression, HTTP/2 or HTTP/3 multiplexing, request coalescing, never the same tile downloaded twice.
- **Fast start:** small initial bundle, lazily loaded modules, first complete frame from the pinned base as fast as possible.
- **Render on demand:** draw continuously while anything moves, animates or loads, and stop drawing when nothing changes, to save battery and heat; throttle in background tabs.

Correctness, zero-defect policy:

- No known bug may remain open at the end of a milestone; every fixed bug gets a regression test first.
- Every external input (tiles, packages, configuration, coordinates) is validated and handled defensively; nothing an external source sends may crash the engine or blank the view.
- The full test strategy is in Testing and verification.

Compatibility:

- **Any map:** standard protocols and adapters for any source, tiling scheme, tile size and image format (see Map sources).
- **Any system:** every platform in Fixed constraints, any GPU vendor (Intel, AMD, NVIDIA, Apple, Qualcomm, ARM), any pixel density and screen size.
- **Any framework:** the framework-agnostic core, the Vue adapter and the Web Component wrapper.
- **Consistency:** the same API and the same visual result on both graphics backends and in every supported browser, within the visual-test tolerances.

## Code quality and readability

Code must be easy to read first, for people and for Claude in later sessions; speed comes from the design and from isolated hot paths, not from clever code everywhere.

- **Simple and direct:** the minimum complexity each feature needs. No speculative flexibility, no options nobody asked for, no helpers or layers for one-time operations, no dead or commented-out code.
- **Abstraction where it pays:** interfaces exist where this plan requires extension points (sources, layers, renderer, cache stores, network policies, framework adapters) or where they remove real duplication. Everywhere else, plain functions and data.
- **Small, focused modules:** one responsibility per file, short functions, the same predictable folder structure in every package, so any file can be understood on its own.
- **Names and types carry meaning:** descriptive names, strict types, no `any`, units in names where they could be ambiguous (meters, degrees, radians, pixels).
- **Comments explain why, not what:** TSDoc on every public API; inline comments only where the logic is not self-evident, such as the math behind a precision technique, with a link to its ADR or source paper.
- **Hot paths are the visible exception:** performance-critical code (per-frame loops, decoders, shaders) may trade some readability for speed, but lives in clearly marked modules that document the reason and the benchmark that justifies it.
- **Errors handled at the boundaries:** validate data where it enters the engine (network, files, configuration, user input) and trust internal code instead of re-checking everywhere.
- **Consistency enforced by tools:** formatter, linter and type checks run automatically on every change (for example through Claude Code hooks and CI), so style never needs discussion.
- **Readable for a fresh session:** a concise CLAUDE.md, ADRs for non-obvious decisions, current documentation, tests next to the code they test, no stale files.

## Research survey (mandatory)

Before designing each subsystem, the agent studies how the best-known open-source engines solve the same problem, writes down what it learned, and then adopts the best approach or improves on it.

| Category | Projects to study |
| --- | --- |
| Virtual globes and 3D GIS | CesiumJS, NASA WorldWind (Web and Java), iTowns, OpenGlobus, osgEarth, 3DTilesRendererJS, loaders.gl |
| Web maps | MapLibre GL JS, MapLibre Native, OpenLayers, Leaflet, deck.gl, Tangram |
| General 3D engines | three.js, Babylon.js, PlayCanvas, Filament, Godot, Bevy, O3DE, bgfx |
| Formats and compression | Draco, Basis Universal and KTX2 tools, PMTiles, quantized-mesh tooling, Martini and Delatin |
| Massive data | Potree |

How to study them:

- **Code:** how each one solves the problem areas of this plan: precision, depth, terrain and imagery levels of detail, tile scheduling and caching, globe-to-flat transitions, camera control, picking, labels, atmosphere, GPU resource management, worker usage.
- **Issue trackers:** their known bugs, glitches and performance complaints, so the same mistakes are avoided from day one.
- **Tests and benchmarks:** how they test rendering, visual regressions and performance.
- **Output:** a written survey per problem area in the repository (for example `docs/research/`): the approaches found, their trade-offs and known failure modes, the approach chosen and why. Update it whenever a new subsystem starts.

Rules: study only, never copy code. Only open-source projects are studied; source-available projects with restrictive licenses (for example Mapbox GL JS from version 2, or Unreal Engine) are excluded to avoid any license contamination.

## Map experience: globe, 2D and 3D

One continuous camera turns the globe into a flat 2D map as the user zooms in, then tilts it gradually into an oblique 3D view, with no mode switch and no visible jump.

Zoom-driven behavior in Auto mode (scales and angles are starting values to tune):

| Phase | Typical scale | Shape | Tilt | Terrain relief |
| --- | --- | --- | --- | --- |
| Globe | World, continents | Ellipsoid | 0° | Flat |
| Flattening | Country | Morphs from globe to flat plane | 0° | Flat |
| 2D map | Region, city | Flat (Web Mercator-like) | 0° | Flat or subtle |
| 3D view | Neighborhood, street | Flat | Rises gradually to 45–60° | Full |

Transition rules:

- Every transition is a smooth, continuous function of zoom (easing curves), never a threshold. Curves may overlap slightly: tilt starts as the map finishes flattening.
- The globe-to-flat morph interpolates positions between the ellipsoid and the plane on the GPU, as MapLibre does between its globe and Mercator projections.
- The geographic point under the cursor (or the screen center) must stay fixed during the morph; otherwise the map slides away while flattening.
- On the flat plane, terrain heights are scaled consistently with the projection's scale factor. Measurements always stay on the ellipsoid.
- Long flights pass through the phases on their own: a flight from Milan to Tokyo rises into the globe phase and descends back to the tilted view.

View modes:

- **Auto (default):** the zoom curves drive tilt and relief.
- **2D locked:** tilt stays at 0° at every zoom. The globe-to-flat morph keeps working, so the user can zoom back out to the globe.
- **Manual tilt (Google Earth behavior):** when the user tilts by hand, that tilt becomes the chosen tilt. It persists at every zoom, through the globe phase and flights, until the user changes it again or picks another mode.
- **Rotation:** the chosen heading also persists until the user changes it; the compass resets north. There is no automatic north-up.
- **Back to Auto:** a visible control next to the 2D/3D toggle. 2D sets tilt to 0°, 3D sets a default tilt, Auto restores the zoom-driven curves.
- **Chosen vs applied values:** store the user's chosen tilt and heading separately from the applied ones. When a choice is impossible at a position (the camera would enter terrain, or empty sky would fill the screen at that altitude), clamp the applied value temporarily and restore the chosen value as soon as possible. Never overwrite the choice.
- **Programmatic movement:** flyTo and similar calls keep the user's tilt and heading unless the call specifies them.

## Navigation and controls

Navigation matches Google Earth, Google Maps and Apple Maps: every movement is smooth, time-based, interruptible and inertial.

| Group | Required capabilities |
| --- | --- |
| Zoom | Wheel and trackpad zoom anchored at the cursor; double-click or double-tap to zoom in; two-finger tap to zoom out; pinch; +/- buttons; box zoom (Shift+drag); fit to bounds or to objects with padding; continuous fractional zoom |
| Pan | Drag with inertia; two-finger pan on touch; keyboard arrows |
| Rotate and tilt | Right-drag or Ctrl+drag; two-finger rotate; two-finger vertical drag to tilt on touch; Shift+arrows; tilt control |
| Orientation | Compass showing heading (click: north up; drag: rotate); one-click orientation to N, E, S or W |
| View | 2D / 3D / Auto toggle; orbit around a point; reset to the globe; project home view |
| Movement API | flyTo (curved zoom-out/zoom-in path), jumpTo (teleport), easeTo (short moves), tours (queued waypoints); all cancellable, with promises and events, honoring the view-mode rules |
| Coordinates | Go to coordinates typed as decimal degrees, degrees-minutes-seconds or UTM; a pluggable geocoder interface with no default provider |
| Constraints | Min and max zoom, max tilt, optional geographic bounds, terrain collision |
| Accessibility | Full keyboard operation; respects the system reduced-motion setting (flights become quick fades) |

All animations are frame-rate independent. Any user input interrupts a running animation and takes over smoothly, without a jump.

## Rendering and visual quality

The renderer must show a complete, stable, artifact-free picture at every moment, from orbit to street level.

- **Precision:** no vertex jitter at street level despite 32-bit GPU floats (for example relative-to-center tile coordinates, or relative-to-eye rendering with emulated double precision).
- **Depth:** no z-fighting between near and far geometry in the same view (for example a logarithmic or reversed depth buffer, or multi-frustum rendering).
- **No black areas:** low-detail base imagery is always present (pinned levels). A missing tile is always covered by its best available ancestor, upsampled.
- **No popping:** imagery level changes cross-fade; terrain uses geomorphing or an equivalent.
- **No seams or cracks:** no filtering lines at tile edges (gutters, padding, correct sampling); terrain cracks between levels are hidden (skirts, stitching).
- **Texture quality:** mipmaps, anisotropic filtering for tilted views, correct color space, support for high-DPI screens with a resolution scale setting.
- **Independent levels:** terrain and imagery choose their levels separately, so detailed imagery can sit on coarser terrain.
- **Horizon and distance:** atmospheric haze or fog hides distant low detail and reduces loads near the horizon; sky and atmosphere when the globe is visible; optional sun lighting by date and time.
- **Poles and antimeridian:** no gaps or seams. Web Mercator stops at about ±85° latitude, so the poles need caps.
- **Culling:** frustum culling and horizon culling.
- **Anti-aliasing** suited to each backend.
- **Draping:** polygons and lines drawn on terrain follow the relief, never floating above it or cutting into it.

## Tiles, level of detail and streaming

The engine loads only what the view needs, most important first, and always has something correct to draw while the rest arrives.

- **Tiling:** quadtree pyramids for imagery and terrain; tiles chosen by screen-space error, from each source's geometric error.
- **Parent fallback:** never discard a parent tile before all the children needed to replace it are ready.
- **Pinned base:** the lowest levels load at startup and are never evicted, so there is always a complete picture.
- **Lazy refinement:** once the base is visible, detail refines progressively toward the level the view needs.
- **Request scheduling:** priorities (screen center first, coarse before fine, visible before prefetch); concurrency limits per host; cancellation of requests that are no longer needed (essential during flights); retries with backoff; timeouts.
- **No data:** an out-of-coverage tile or a 404 means no data: stay on the parent and never retry endlessly. Sources declare coverage so missing tiles are never requested.
- **Off the main thread:** decoding and mesh generation run in workers.
- **Frame budget:** GPU uploads and other expensive work are spread across frames so no single frame stutters.
- **GPU texture compression** (for example KTX2/Basis) where it reduces memory and upload time.
- **Memory budgets** for GPU and RAM, with least-recently-used eviction.
- **Motion-aware detail:** accept coarser detail during fast motion; refine when the camera slows or stops.
- **Flight preloading:** when a flight starts, load the destination at the levels needed on arrival; along the path, load only what will actually be visible.

## Map sources: map-agnostic design

Any map or terrain can be attached through a source adapter: technically the engine accepts any standard format, legally each provider's terms decide what is allowed.

- **Adapter interface:** every imagery, terrain, vector or 3D source implements a common plugin interface. Consumers can write their own adapters for proprietary or unusual services.
- **Source metadata:** tiling scheme and coordinate reference system, coverage bounds, zoom range, tile size, attribution, cache and offline permissions, authentication headers or tokens, rate limits.
- **Reprojection:** raster sources in another reference system (for example Italian data in UTM zones 32 and 33) are reprojected, or requested in a supported system when the service allows it.
- **Composition:** layers stack with order, opacity, visibility and blending. Each layer can have a chain of sources with priorities (for example offline base first, online detail second) that falls back automatically by coverage and availability.
- **Color harmonization:** when a layer switches between sources with different tones, blend or adjust so the switch is not visible.
- **Terms awareness:** adapters declare each provider's rules and the engine enforces them (no caching or offline packaging where forbidden; required attribution or logo always shown). Known examples: Apple map data may only be used through Apple's own MapKit; Google's tiles require Google's logo and forbid caching; OpenStreetMap's public tile servers forbid offline and heavy use.

Built-in adapters to provide at minimum:

| Kind | Formats and protocols |
| --- | --- |
| Imagery | XYZ/TMS tile URLs, WMTS, WMS, PMTiles, MBTiles, single georeferenced images |
| Terrain | quantized-mesh, heightmap tiles (for example Terrarium, Terrain-RGB) |
| Vector | GeoJSON, KML, GPX, Mapbox Vector Tiles (MVT) |
| 3D | glTF models, 3D Tiles |

Compatibility requirements:

- **Tiling schemes:** Web Mercator, geographic (plate carrée), and custom TMS or WMTS tile matrix sets in any reference system, through reprojection.
- **Tiles:** 256 and 512 pixel tiles, high-DPI (@2x) tiles, and every image format the browser decodes (PNG, JPEG, WebP, AVIF).
- **Vector styling:** compatible with the MapLibre Style Specification, so existing vector map styles work as they are.
- **Terrain:** any common elevation encoding, through adapters.
- **Consistency:** a source looks and behaves the same in the globe, 2D and 3D phases.
- **Conformance suite:** every adapter has a conformance test suite, run against fixtures and, where the provider's terms allow it, against real public endpoints.

Provider profiles (Google and OpenStreetMap are required):

Each provider adapter ships a profile: the set of engine features that provider's terms allow. Every feature is enabled by default; a profile switches off, for its own source only, exactly what the provider forbids. Developers can switch off more, globally or per source, but cannot switch on what a profile forbids.

| Provider | Access | What the profile enforces |
| --- | --- | --- |
| Google Maps Platform | Map Tiles API: 2D tiles (roadmap, satellite, terrain), Photorealistic 3D Tiles, Street View tiles; the customer's own API key and session tokens | Google logo and attributions always visible and never covered; no persistent cache, prefetch or offline packaging beyond what Google's terms and cache headers allow; content used for display only; 3D sessions renewed when their token expires (about three hours); the terms that apply to the customer's billing region (Google has separate terms for the EEA) |
| OpenStreetMap, public servers | Raster and vector tiles from the OpenStreetMap Foundation servers | Light use only: no offline packaging or bulk prefetch, low request concurrency, the application identified as the usage policy requires, attribution to OpenStreetMap contributors; documented as unsuitable for production products |
| OpenStreetMap, self-hosted or via a provider | Tiles built from OSM data by the data pipeline, or served by a commercial provider | Everything enabled; ODbL attribution; a provider's own terms apply when one is used |
| Any other provider | Through the adapter interface | The adapter declares its profile and the engine enforces it the same way |

When implementing a profile, read the provider's current terms and usage policy and record that reading in an ADR, because terms change over time.

## Offline, online and caching

The engine works with no internet, with a fast connection and anything in between, choosing for each tile the best source it can get without causing lag.

- **Cache hierarchy:** GPU, then RAM, then persistent browser storage (for example IndexedDB or OPFS), then offline packages, then the network.
- **Offline mode 1, local-network server:** offline packages are served over HTTP by a server on the LAN, for example Cube installed at a customer site with no internet.
- **Offline mode 2, device:** packages or cached tiles live in the browser. Handle storage quotas and possible eviction by the browser, and let apps request persistent storage.
- **Mixed mode (default when online):** a fixed low-detail package gives an instant start and smooth flights; higher detail is fetched online on demand.
- **Connectivity detection:** health checks against the tile endpoints, not the browser's online flag alone (it reports online behind captive portals). Switch seamlessly when connectivity drops or returns.
- **Bandwidth adaptation:** estimate throughput from measured tile downloads (the browser's Network Information API is missing in Firefox and Safari). Like adaptive video streaming, use the estimate to choose the maximum detail during flights, the prefetch depth and the request concurrency.
- **Cache policy per source:** respect provider cache headers and terms; version offline packages; invalidate by version number or ETag when data changes.
- **Offline package builder:** input an area (bounding box or polygon), a zoom range and sources whose licenses allow it; output a package (for example PMTiles or MBTiles). Estimate the size before building (each extra zoom level roughly quadruples the tile count); support resumable downloads and integrity checks.
- **Package management API:** apps can list, install, update and remove packages, and read storage use.

Configuration switches (global, overridable per layer, changeable at runtime):

| Switch | Options | Default | Behavior |
| --- | --- | --- | --- |
| Network mode | Online only, offline only, hybrid | Hybrid | Online only never reads offline packages. Offline only never touches the network: no requests at all, health checks included, suitable for air-gapped sites. Hybrid is the mixed behavior described above. |
| Persistent cache | On, off | On | Stores tiles in browser storage across sessions. |
| Memory reuse | On, off | On | Keeps recently used tiles in RAM and GPU memory after they leave the screen. When off, only the working set needed to draw the current view stays in memory, released as soon as it is off screen. |
| Prefetch and flight preloading | On, off | On | Loads tiles before they become visible: around the view and at flight destinations. |
| Offline packaging | On, off | On | Allows a source's tiles to be included in offline packages. |

Provider profiles (see Map sources) switch off, for their own source, any of these features the provider's terms forbid, whatever the global setting. Disabling the cache cannot mean zero memory: tiles on screen must stay in GPU memory while visible.

## Data layers for applications

Applications such as Cube draw their own data on top of the map, with picking, styling and live updates at interactive speed.

- **Primitives:** points, markers and billboards, labels, polylines, polygons, extruded polygons, circles and ellipses, 3D models (glTF).
- **Placement:** lines and polygons draped on terrain; markers and models clamped to the ground and re-adjusted when terrain detail changes; or placed at an absolute altitude.
- **Elevation queries:** height at a coordinate, both a fast best-available answer and an asynchronous most-precise answer.
- **Large datasets:** from thousands to hundreds of thousands of points, with clustering and level of detail for markers.
- **Live updates:** change the position, style or visibility of single features without rebuilding the layer (for example sensor feeds).
- **Styling:** data-driven styles from feature properties, and zoom-dependent styles.
- **Labels:** crisp text at any size (for example signed distance field fonts), collision detection and decluttering, priorities.
- **Interaction:** hover, click, selection highlight, optional dragging; events carry the feature and its coordinates; picking also works on bare terrain.
- **Data loading:** the vector formats listed in Map sources, plus streaming from application APIs.
- **OpenStreetMap content:** roads, places and buildings from a self-hosted OpenStreetMap extract; buildings extruded where height data exists, with sensible defaults where it is missing.

## GIS utilities

Common GIS tools ship with the engine, so every project gets them without extra work.

- **Cursor readout:** coordinates and terrain elevation under the pointer.
- **Coordinate formats:** parse and format decimal degrees, degrees-minutes-seconds and UTM; transform between reference systems with a projection library.
- **Geodesic measurement on the ellipsoid:** distance, path length, area, bearing (for example with Karney's algorithms).
- **Drawing tools:** draw and edit points, lines and polygons; the measurement tools build on them.
- **Scale bar:** referred to the view center, since scale varies across a tilted view.
- **Geolocation:** show and fly to the user's position.
- **View state:** serialize the camera (position, zoom, heading, tilt, view mode) to and from a URL or JSON; saved views and bookmarks.
- **Export:** screenshot of the current view at a chosen resolution.
- **Overview:** an optional minimap.

## UI, accessibility and internationalization

The core is headless; an optional UI package provides ready-made controls that apps can theme, extend or replace.

- **Ready-made controls:** zoom +/-, compass, 2D/3D/Auto toggle, tilt control, reset to globe and home, coordinates readout, scale bar, attribution, layer switcher, search box (with the pluggable geocoder), fullscreen, debug panel toggle.
- **Theming:** CSS variables, light and dark themes; apps can restyle every control.
- **Languages:** English and Italian included; translations are pluggable.
- **Accessibility:** keyboard focus and operation, ARIA labels, sufficient contrast, reduced motion.
- **Attribution:** credits for the sources currently visible, updated live and never hidden by other controls.

## Debugging, diagnostics and adaptive quality

Developers can see what the engine is doing at any moment, and the engine lowers its own detail before the user feels lag.

- **Debug overlay:** tile boundaries and levels, screen-space error, source per tile, cache hits and misses, requests in flight, GPU and RAM memory, frame time, frame rate.
- **Performance instrumentation:** timing marks visible in the browser's performance tools; a compact performance HUD.
- **Logging and tracing:** log levels; event traces for tiles, requests and camera movement.
- **Quality presets:** for example low, medium, high and ultra, controlling detail, resolution scale and effects.
- **Adaptive quality:** watch frame time; lower detail or resolution automatically when the frame rate drops, and raise it back once performance is stable.
- **Capability detection:** active backend, GPU limits, memory hints; pick sensible defaults per device.

## Security, robustness and licensing compliance

The engine must run inside strict enterprise environments and must never break the licenses of the data it shows.

- **Content Security Policy:** no eval or dynamic code generation; workers, WebAssembly and other assets load as separate files from configurable URLs.
- **Network access:** CORS-aware fetching; per-source authentication headers or tokens; avoid secrets in URLs.
- **GPU device or context loss:** detect it and recover without reloading the page.
- **Lifecycle:** a destroy method frees GPU memory, RAM, workers and event listeners; no leaks across repeated mount and unmount in single-page apps; several engine instances can run on one page.
- **Resilience:** corrupted tiles, slow servers and partial packages are handled gracefully, never with a blank or frozen view.
- **License audit:** dependency licenses checked in CI, failing on disallowed licenses; a generated third-party notices file; bundled assets (fonts, icons, sample data) with compatible licenses.
- **Attribution:** required credits for every visible source are always displayed.
- **Privacy:** no telemetry by default; nothing is sent anywhere except the configured sources.

## Architecture guidance

Recommended shape: a framework-agnostic core with the renderer behind its own interface, plug-in sources, layers and controls, and thin framework adapters. The agent finalizes the design.

&#91;embedded content: engine architecture · core, plug-ins, adapters, data\]

Apps use the core directly or through the Vue adapter or the Web Component, plus the optional UI package; plug-ins attach to the core, and the data pipeline fills the tile servers and offline packages that sources read.

Suggested packages in a monorepo:

| Package | Responsibility |
| --- | --- |
| core | Math, geodesy, ellipsoid and projections; camera and view modes; tiling and level of detail; request scheduler; cache; events |
| renderer | Backend implementation (WebGPU with WebGL2 fallback), shaders, GPU resource management |
| sources | Adapters: XYZ, WMTS, WMS, PMTiles, MBTiles, terrain formats, vector formats, 3D formats |
| layers | Data primitives, labels, picking, styling |
| controls | Input handling, gestures, navigation logic |
| offline | Persistent cache, loading-feature switches, network modes, offline packages, connectivity and bandwidth logic |
| ui | Optional ready-made controls, theming, translations |
| vue | Vue 3 adapter (components, composables), SSR-safe |
| web-component | Framework-neutral custom element, usable from any framework or plain HTML |
| tools | Command-line tools for the data pipeline and the offline package builder |
| playground | Demo app that exercises every feature; also the bed for visual and scenario tests |

Renderer recommendation:

- Start on three.js: its WebGPURenderer uses WebGPU with an automatic WebGL2 fallback, and shaders written once in TSL compile to WGSL or GLSL. That saves writing and maintaining two graphics backends.
- Keep three.js behind the engine's own renderer interface, and keep all globe logic (tiles, levels of detail, precision, camera) in the engine.
- For tiles, disable three.js automatic matrix updates and frustum culling (the engine culls), and control when textures are uploaded to the GPU.
- Pin the three.js version: it releases often and changes APIs between versions.
- Replace hot paths with lower-level code only when profiling proves a bottleneck. A fully custom renderer is acceptable if measurements justify it.
- Use WebAssembly only for isolated CPU-heavy work in workers (mesh generation, decoding), and only if profiling shows the need.

Public API: typed configuration, events, promises for animations, tree-shakeable and side-effect-free imports, semantic versioning with a stable API from 1.0.

## Default datasets and data pipeline

Default data is free, commercially usable and self-hosted; a pipeline turns raw downloads into tiles and offline packages. Licenses below were checked during planning: the agent must re-verify them before shipping (links in References).

| Layer | Dataset | Notes |
| --- | --- | --- |
| Terrain | Copernicus DEM GLO-30 (30 m, global) | Free license with attribution when modified; a surface model (includes buildings and vegetation); public on AWS Open Data |
| Detailed imagery | Sentinel-2 cloudless 2016 by EOX (about 10 m per pixel) | Only the 2016 edition allows commercial use (2018 and later editions are non-commercial); self-host it (original tiles in an AWS requester-pays bucket); attribution required |
| Global fallback imagery | Natural Earth raster (public domain) or equivalent | Very low resolution for the whole world |
| Vectors | OpenStreetMap (ODbL) | Download extracts (for example from Geofabrik) and self-host; public OSM tile servers must not be used in products; credit OpenStreetMap contributors |
| Fresher imagery (optional) | Mosaic built from raw Copernicus Sentinel-2 data | Free and commercially usable, with the Copernicus notice and year |

Pipeline requirements:

- Command-line tools (TypeScript; may call GDAL or other tools, for example through Docker) to download, convert and tile each dataset: DEM to terrain tiles, imagery to tile pyramids, OSM extracts to vector tiles and, if useful, raster tiles.
- Region-based builds: low detail for the whole world, high detail for chosen regions (Italy first, for Cube).
- Output both offline packages and static tile folders, ready for any HTTP server or CDN.
- Record license and attribution with every output; refuse to package sources whose terms forbid it.
- Reproducible from versioned configuration files; resumable; size estimates before building.

## Performance and quality targets

Every milestone is judged against measurable targets. These values are proposals: the agent defines the reference devices and refines the numbers in its own plan, but may not weaken the zero-artifact targets.

| Target | Proposed value |
| --- | --- |
| Frame rate during pan, zoom and flights on the reference desktop | 60 fps; 95th-percentile frame time at most 16.7 ms |
| Frame rate on the reference tablet | At least 30 fps, goal 60 fps |
| Black or empty pixels during scripted zoom, pan and flight scenarios, after the base has loaded | 0 |
| First complete frame from a local or offline base | At most 1 s on a LAN server |
| Visible level-of-detail popping | None |
| Vertex jitter at street level | None visible |
| Memory | Within the configured GPU and RAM budgets; no growth over 100 mount and unmount cycles |
| Offline behavior | Full navigation with no network; seamless switch when the network drops or returns |

## Testing and verification

Automated tests cover math, logic and visuals; real devices confirm performance.

- **Unit tests:** geodesy, projections, transforms, tiling, screen-space-error selection, scheduler, cache, coordinate parsing and formatting.
- **Integration tests:** every source adapter against fixtures; offline packages; connectivity changes.
- **Visual regression:** screenshot comparison of canonical views on both backends.
- **Scenario tests:** scripted camera paths (globe to street zoom, long flights, fast pans, rotations, tilt changes) that record frames and automatically detect background or black pixels, holes and popping (frame differencing).
- **Performance benchmarks:** frame-time distribution, time to first frame, tiles loaded, requests, memory; tracked over time to catch regressions.
- **Network simulation:** offline, slow, flaky and high-latency links; LAN-only mode.
- **Browser matrix:** Chrome, Edge, Firefox and Safari, on the WebGPU path and the forced WebGL2 path.
- **Continuous integration:** CI machines usually have no GPU. Run visual tests there on WebGL2 with software rendering; run WebGPU and performance tests on real hardware locally, with a documented procedure.
- **Adapter tests:** the Vue adapter in a minimal Nuxt app, covering the SSR build and client hydration.
- **Housekeeping in CI:** license audit, API documentation build, type checks, lint.

Zero-defect practices, on top of the above:

- **Regression first:** every bug fix starts with a failing test that reproduces it.
- **Property-based tests** for math and geodesy: random inputs checked against invariants (round trips, symmetry, continuity at poles and the antimeridian).
- **Fuzzing** of every decoder and parser: tiles, packages, configuration, coordinate strings.
- **Temporal glitch detection:** frame-by-frame analysis of recorded scenarios for flicker, popping, z-fighting shimmer and seams, not only single screenshots.
- **Soak tests:** hours of randomized navigation, checking memory growth, leaks, crashes and frame time.
- **Chaos tests:** random network failures, slow or corrupted responses, storage quota errors, injected GPU device or context loss.
- **Lifecycle edge cases:** window resize, pixel-density changes, moving between monitors, hidden and visible tabs, sleep and resume, rapid mount and unmount.
- **Hardware and OS matrix:** Windows, macOS, Linux, ChromeOS, iPadOS and Android tablets; Intel, AMD, NVIDIA, Apple, Qualcomm and ARM GPUs; results recorded for every release.
- **Coverage:** a high line-coverage threshold for core logic (for example 90%), enforced in CI.
- **Release gate:** no open known bugs.

## Milestones (all must be completed)

Work proceeds through these 15 milestones; each closes only when its acceptance criteria pass, and the project closes only when all are done. The agent may reorder or split milestones when dependencies require it, but none may be dropped.

1. **Research and foundation:** the written research survey for the core areas, monorepo, build (ESM plus type declarations), lint and format, tests, CI, license audit, documentation site scaffold, playground app, ADR and progress-log conventions, debug overlay skeleton.
   - Done when: the core research survey is written, CI is green and the playground runs.
2. **Globe core:** WGS84 math, camera model, precision and depth strategy, renderer bootstrap with WebGPU and WebGL2 fallback, plain globe with pinned low-resolution imagery, basic drag and zoom.
   - Done when: zooming from orbit to about 1 m above the ground shows no jitter and no z-fighting on both backends.
3. **Imagery streaming:** quadtree, screen-space-error selection, parent fallback, scheduler with priorities and cancellation, RAM cache, workers, upload budget, cross-fade, seam-free edges, complete debug overlay.
   - Done when: scripted zoom and pan scenarios show zero black pixels and no popping.
4. **Terrain:** terrain adapters, mesh generation, skirts or stitching, geomorphing, independent levels for terrain and imagery, height queries, terrain collision.
   - Done when: no cracks, correct relief, and the camera never enters the terrain.
5. **Globe, map and 3D view:** globe-to-flat morph with a fixed anchor point, zoom-driven tilt and relief curves, view modes (Auto, 2D locked, manual), chosen vs applied values.
   - Done when: a continuous zoom from the globe to an oblique street view is smooth at the target frame rate, with no jumps.
6. **Navigation:** every control and gesture in Navigation and controls; flyTo, jumpTo, easeTo and tours; inertia; keyboard; touch; constraints; reduced motion.
   - Done when: every listed interaction works on desktop and tablet.
7. **Sources and composition:** all built-in adapters including the Google and OpenStreetMap profiles, reprojection, layer stack, source chains, color harmonization, attribution, enforcement of provider terms.
   - Done when: each adapter passes its conformance suite and a mixed stack switches sources without visible seams.
8. **Offline and adaptive loading:** persistent cache, the loading-feature switches, the three network modes, both offline modes, package builder, package management API, connectivity and bandwidth adaptation, flight preloading, motion-aware detail.
   - Done when: the network scenarios pass (offline, slow, flaky, connection dropping and returning), and every combination of network mode and loading-feature switch behaves as specified.
9. **Data pipeline and default datasets:** tools for the DEM, Sentinel-2 2016, OpenStreetMap and the global fallback; world low-detail and Italy high-detail builds; license and attribution files.
   - Done when: the default datasets rebuild reproducibly from configuration.
10. **Data layers:** primitives, draping and ground clamping, clustering, labels with collision, styling, picking and events, live updates, glTF models.
    - Done when: 100,000 points with clustering stay at the target frame rate, and draped shapes follow terrain at every level.
11. **Atmosphere and quality:** sky, atmosphere, fog, lighting, anti-aliasing, anisotropic filtering, quality presets, adaptive quality.
    - Done when: adaptive quality holds the target frame rate on the reference tablet.
12. **GIS utilities and UI:** every tool in GIS utilities; the UI package with theming, English and Italian, and accessibility.
    - Done when: every control works with mouse, touch and keyboard alone.
13. **Vector tiles, buildings and 3D Tiles:** MVT rendering on the globe and the flat map, OpenStreetMap building extrusions, 3D Tiles streaming.
    - Done when: a city view with roads, labels and buildings meets the performance targets.
14. **Framework adapters:** the Vue adapter (components and composables, SSR-safe), the Web Component wrapper, a Nuxt example app, an integration guide for consumers such as Cube.
    - Done when: the Nuxt example builds with SSR and runs every feature on the client, and the Web Component works in a plain HTML page.
15. **Hardening and release:** performance pass on the reference devices, the full hardware and OS matrix, soak and chaos tests, cross-browser fixes, complete documentation, API review, version 1.0.0 published to a private package registry.
    - Done when: every item in Definition of done is ticked.

## Documentation and distribution

The library ships with documentation good enough that a new project can integrate it without reading the source.

- **Documentation:** README; getting started; architecture overview; API reference generated from the types; guides for sources and custom adapters, offline packages, performance tuning, data layers and Vue/Nuxt integration; ADRs; changelog; third-party notices; data licenses and attributions.
- **Examples:** the playground covers every feature, plus a minimal example per feature.
- **Distribution:** a private package registry for now (for example GitHub Packages); semantic versioning; ESM builds with type declarations; tree-shakeable packages; workers, WebAssembly and shader assets resolvable by common bundlers (Vite, Nuxt) or from configurable URLs.
- **Release automation:** changelog generation, version tags, publishing from CI.
- **Consumption by Cube:** Cube installs the packages from the private registry like any other dependency; nothing in the engine refers to Cube.

## Definition of done

The project is complete only when every item below is true.

- [ ] All 15 milestones are complete and their acceptance criteria pass.
- [ ] Every entry in the feature list passes, proven end to end in a real browser.
- [ ] The research survey covers every problem area, with the chosen approach justified.
- [ ] The performance and quality targets and every budget are met on the reference devices, with recorded results.
- [ ] Every feature from Map experience through Security works on desktop and tablet, on the WebGPU and WebGL2 paths, across the full hardware and OS matrix.
- [ ] Online only, offline only and hybrid modes, both offline setups and every loading-feature switch are verified in every combination.
- [ ] Every source adapter passes its conformance suite, including the Google and OpenStreetMap profiles.
- [ ] Soak, chaos, fuzzing and temporal-glitch tests pass; no open known bugs remain.
- [ ] The default datasets rebuild reproducibly with correct licenses and attribution.
- [ ] The Vue adapter works in a Nuxt app with SSR, and the Web Component works in plain HTML.
- [ ] Documentation and examples are complete, CLAUDE.md is current, and the license audit is clean.
- [ ] Version 1.0.0 is published to the private registry.

## Decision log from the planning discussion

These choices were made with the owner before implementation; the reasons are kept so the agent does not reopen them by accident.

| Decision | Reason |
| --- | --- |
| Build our own engine rather than use CesiumJS directly | Full control over fluidity, behavior and modularity; existing engines are studied for their solutions, never copied |
| Extreme optimization, mandatory research survey, zero-defect policy | The owner's requirement: the engine must be as optimized as possible, learn from every major engine, and ship without bugs or glitches |
| Readable, minimal code; abstraction only at extension points | The owner's requirement: optimized but readable, without over-engineering, so Claude can keep working on it across sessions |
| Working method with feature list, progress notes, git and end-to-end checks | Follows Anthropic's published practice for long-running coding agents, so the build stays coherent across many sessions |
| TypeScript | The engine runs on browser APIs; types are the library's contract; same stack as Cube (Vue/Nuxt with TypeScript) |
| Globe-to-flat morph rather than an always-round globe | At mid zoom the view must be a true flat 2D map, as in Google Maps; most tile sources are Web Mercator and fit the flat phase without reprojection |
| Automatic globe, 2D and 3D by zoom, with a persistent manual override | The owner's requirement, modeled on Google Earth: a chosen tilt or heading stays until the user changes it |
| three.js recommended as the rendering base | WebGPU with automatic WebGL2 fallback and single-source shaders save months; fluidity depends mostly on engine logic; hot paths remain replaceable |
| Network mode configurable, default hybrid | Projects may run only online, only offline or both; the owner chose both as the default |
| Every loading feature enabled by default, each one switchable | The owner wants everything on by default, with the option to switch features off globally or per source |
| Provider profiles for Google and OpenStreetMap | The engine must work with both; each profile switches off only what that provider's terms forbid |
| Map-agnostic adapters and a Web Component wrapper | The engine must work with any map and from any framework or system |
| Only free, commercially redistributable data by default | The engine and Cube are sold commercially; paid tiers (Google, Mapbox, MapTiler, Cesium ion) are optional adapters, not defaults |
| Apple MapKit rejected | Its terms forbid using Apple map data outside Apple's own MapKit and storing it, and add commercial restrictions on non-Apple hardware |
| Both offline modes | Cube runs at customer sites without internet and on devices without network |
| Desktop first, tablets supported | The owner's priority |
| Private repository, English throughout | The owner's choice; the license will be decided before any public release |

## References

Study these to learn how each problem was solved; reimplement, never copy.

Key engines and what each is best studied for (the full list is in Research survey):

| Engine | Study for |
| --- | --- |
| CesiumJS | Almost everything: precision, depth, terrain, tiling, imagery on terrain, picking, camera |
| MapLibre GL JS | Globe-to-Mercator transition, labels and collision, workers, vector tiles |
| deck.gl | Precision techniques (emulated 64-bit, offset coordinates) |
| iTowns, OpenGlobus | Smaller globe engines with readable code; iTowns is built on three.js |
| 3DTilesRendererJS (NASA) | Tile traversal and 3D Tiles on three.js |
| NASA WorldWind, osgEarth | Long-lived engines; terrain engine design |

Literature:

- Cozzi and Ring, 3D Engine Design for Virtual Globes (2011)
- Ulrich, Rendering Massive Terrains using Chunked Level of Detail Control (SIGGRAPH 2002 course)
- Losasso and Hoppe, Geometry Clipmaps (2004)
- van Wijk and Nuij, Smooth and Efficient Zooming and Panning (2003)
- O'Neil, Accurate Atmospheric Scattering, GPU Gems 2 (2005)
- Bruneton and Neyret, Precomputed Atmospheric Scattering (2008)
- Karney, Algorithms for Geodesics (2013)
- Green, Improved Alpha-Tested Magnification for Vector Textures and Special Effects (2007), for distance-field text
- Agafonkin, MARTINI: Real-Time RTIN Terrain Mesh (2019)

Specifications: quantized-mesh, OGC 3D Tiles, PMTiles, MBTiles, Mapbox Vector Tile specification, OGC WMTS and WMS, glTF 2.0.

License and platform pages consulted during planning (re-verify before shipping):

- [Copernicus DEM on AWS Open Data](https://registry.opendata.aws/copernicus-dem/)
- [Sentinel-2 cloudless original tiles (EOX)](https://eox.at/2017/03/sentinel-2-cloudless-original-tiles-available/)
- [EOxCloudless non-commercial license, 2018 and later editions](https://cloudless.eox.at/license-non-commercial)
- [Copernicus Sentinel data licence](https://ads.atmosphere.copernicus.eu/licences/ec-sentinel)
- [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
- [Google Map Tiles API policies](https://developers.google.com/maps/documentation/tile/policies)
- [three.js WebGPURenderer](https://threejs.org/manual/en/webgpurenderer)
- [Network Information API browser support](https://www.caniuse.com/netinfo)

Working with Claude, the guidance this plan follows:

- [Prompting best practices (Anthropic)](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices)
- [Effective harnesses for long-running agents (Anthropic Engineering)](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Harness design for long-running application development (Anthropic Engineering)](https://www.anthropic.com/engineering/harness-design-long-running-apps)
