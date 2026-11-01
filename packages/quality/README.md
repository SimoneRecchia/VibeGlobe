# @vibeglobe/quality

Quality presets and adaptive quality for a VibeGlobe globe. `createQuality` applies a preset (`low`, `medium`, `high`
or `ultra`), or chooses one from the device's capabilities, and then steps detail and resolution down while frames
are slow and back up once they are fast. An application needs it to run smoothly on weak and strong devices alike
without tuning the globe by hand. In Vue, the `qualityPreset` prop of `VibeGlobe` does the same.

## Install

`@vibeglobe/core` installs with it; there are no peer dependencies. It drives a globe only through its public API.

## Entry points

| Import               | What                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `@vibeglobe/quality` | `createQuality`, `QUALITY_PRESETS`, `choosePreset`, `FrameTimeGovernor`, `GOVERNOR_DEFAULTS` |

## Example

```ts
import type { Globe } from '@vibeglobe/core';
import { createQuality } from '@vibeglobe/quality';

declare const globe: Globe;

await globe.ready;
const quality = createQuality(globe, { preset: 'auto' });
console.log(quality.preset, quality.choice?.reason);
quality.onChange(({ reason, level, settings }) => console.log(reason, level, settings.resolutionScale));
```

## Presets

| Preset   | `resolutionScale` | `maxScreenErrorPx` | `antialias` | `atmosphere` | `maxPixelRatio` |
| -------- | ----------------: | -----------------: | ----------- | ------------ | --------------: |
| `low`    |               0.5 |                  4 | `'none'`    | `'low'`      |               1 |
| `medium` |              0.75 |                  2 | `'fxaa'`    | `'medium'`   |             1.5 |
| `high`   |                 1 |                  1 | `'msaa4'`   | `'high'`     |               2 |
| `ultra`  |              1.25 |               0.75 | `'msaa4'`   | `'ultra'`    |       unlimited |

`'auto'` chooses `low` for a software renderer, at most 2 GiB of memory, textures under 4096 texels or at most 2
processors; `medium` for WebGL2, at most 4 GiB, at most 4 processors or a touch device; `high` otherwise. It never
chooses `ultra`.

Adaptive quality (`adaptive`, default `true`) judges the median of the last 30 frame intervals against 60 fps. It
lowers one step after 500 ms above 1.15 × the target, and raises one after 3 s below 0.75 × the target, with at least
2 s between changes. Steps alternate resolution × 0.85 and screen error × 1.4, down to 0.4 and 8 px; effects stay.
An object for `adaptive` overrides `GOVERNOR_DEFAULTS`.

## Pitfalls

- Create it after `globe.ready`: before, `'auto'` cannot read the capabilities and chooses `medium`.
- It sets the globe's resolution scale and quality settings, overriding the values given to `createGlobe`.
- An unknown preset name throws a `TypeError`.
- `destroy()` stops adapting and keeps the applied settings.
