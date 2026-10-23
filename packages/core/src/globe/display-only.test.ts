import { describe, expect, it } from 'vitest';
import { refuseDisplayOnly } from './display-only.js';
import { GlobeError } from './errors.js';
import type { ImageryRuntime } from './imagery-runtime.js';

const google = { id: 'google', displayOnly: true };
const layer = (id: string, visible: boolean, profile?: object) => ({
  entry: { visible, opacity: 1 },
  chain: [{ source: { id, profile } }],
});
const runtime = (layers: object[], terrain?: object): ImageryRuntime =>
  ({ stack: layers, terrain: terrain && { source: terrain } }) as unknown as ImageryRuntime;

describe('display-only sources (F323)', () => {
  it('refuses pixel readback while a display-only layer is drawn, naming its profile', () => {
    const refused = (): void =>
      refuseDisplayOnly(runtime([layer('osm', true), layer('roadmap', true, google)]), 'captureFrame', 'imagery');
    expect(refused).toThrow(GlobeError);
    expect(refused).toThrow("captureFrame is refused: source 'roadmap' is display only under the 'google' profile");
    expect(() =>
      refuseDisplayOnly(runtime([layer('roadmap', false, google)]), 'captureFrame', 'imagery'),
    ).not.toThrow();
  });

  it('refuses elevation sampling of a display-only terrain source, and allows it otherwise', () => {
    expect(() => refuseDisplayOnly(runtime([], { id: 'heights', profile: google }), 'elevationAt', 'terrain')).toThrow(
      "elevationAt is refused: source 'heights'",
    );
    expect(() => refuseDisplayOnly(runtime([layer('roadmap', true, google)]), 'elevationAt', 'terrain')).not.toThrow();
  });
});
