import { describe, expect, expectTypeOf, it } from 'vitest';
import { createGlobe } from './create-globe.js';
import type { GlobeError } from './errors.js';
import { fakeRenderer } from './test-renderer.js';
import type { BackendName, CameraState, GeoPosition, Globe, GlobeEvents, GlobeOptions, ScreenPoint } from './types.js';

// These checks run in the type checker (`tsc -b` compiles test files): a `@ts-expect-error` line that compiles
// without an error fails the build, so each one proves the API rejects that misuse at compile time.
describe('typed public API (F049)', () => {
  it('types the options and rejects wrong option types at compile time', () => {
    const { factory } = fakeRenderer();
    const options: GlobeOptions = { container: {}, renderer: factory, baseImageryUrl: 'world.jpg', view: { zoom: 3 } };
    // @ts-expect-error zoom must be a number
    const badZoom: GlobeOptions = { ...options, view: { zoom: '3' } };
    // @ts-expect-error the renderer must be a renderer factory
    const badRenderer: GlobeOptions = { ...options, renderer: 'webgpu' };
    // @ts-expect-error baseImageryUrl is required
    const missingImagery: GlobeOptions = { container: {}, renderer: factory };
    expect([badZoom, badRenderer, missingImagery]).toHaveLength(3);
    createGlobe(options).destroy();
  });

  it('types event payloads', () => {
    expectTypeOf<GlobeEvents['ready']>().toEqualTypeOf<{ readonly backend: BackendName }>();
    expectTypeOf<GlobeEvents['error']>().toEqualTypeOf<GlobeError>();
    expectTypeOf<GlobeEvents['camera-change']>().toEqualTypeOf<CameraState>();
    expectTypeOf<Globe['on']>().parameter(0).toEqualTypeOf<keyof GlobeEvents>();
    const { factory } = fakeRenderer();
    const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'world.jpg' });
    globe.on('frame', (payload) => expectTypeOf(payload.frameNumber).toBeNumber());
    // @ts-expect-error unknown event names are rejected
    globe.on('frames', () => undefined);
    globe.destroy();
  });

  it('returns promises from asynchronous operations and plain values from synchronous ones', () => {
    expectTypeOf<Globe['ready']>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<Globe['screenToGeo']>().returns.toEqualTypeOf<GeoPosition | undefined>();
    expectTypeOf<Globe['geoToScreen']>().returns.toEqualTypeOf<ScreenPoint | undefined>();
  });
});
