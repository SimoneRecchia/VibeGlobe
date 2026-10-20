// A strict consumer of the built packages: it must type-check against their published declarations.
import { FrameStats, WGS84, type Ellipsoid } from '@vibeglobe/core';
import type {} from '@vibeglobe/controls';
import type {} from '@vibeglobe/layers';
import type {} from '@vibeglobe/offline';
import type {} from '@vibeglobe/renderer';
import type {} from '@vibeglobe/sources';
import type {} from '@vibeglobe/tools';
import { createDebugOverlay, type DebugOverlay } from '@vibeglobe/ui';
import type {} from '@vibeglobe/vue';
import type {} from '@vibeglobe/web-component';

const ellipsoid: Ellipsoid = WGS84;
const stats = new FrameStats(60);
stats.recordFrame(0);
const fps: number | undefined = stats.framesPerSecond;
const overlay: (container: HTMLElement) => DebugOverlay = createDebugOverlay;

export const consumer = { ellipsoid, fps, overlay };
