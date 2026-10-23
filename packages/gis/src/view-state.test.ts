import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import type { CameraState } from '@vibeglobe/core';
import {
  viewStateFromFragment,
  viewStateFromJson,
  viewStateFromUrl,
  viewStateToJson,
  viewStateOf,
  viewStateToUrl,
  type ViewState,
} from './view-state.js';

const VIEW: ViewState = {
  longitudeDeg: 9.190000000000001,
  latitudeDeg: 45.4642,
  zoom: 14.123456789,
  headingDeg: 33.3,
  tiltDeg: 52.5,
  viewMode: 'auto',
  chosenTiltDeg: 60,
};

describe('view-state serialization', () => {
  const view = fc.record(
    {
      longitudeDeg: fc.double({ min: -180, max: 180, maxExcluded: true, noNaN: true }),
      latitudeDeg: fc.double({ min: -90, max: 90, noNaN: true }),
      zoom: fc.double({ min: -2, max: 28, noNaN: true }),
      headingDeg: fc.double({ min: 0, max: 360, maxExcluded: true, noNaN: true }),
      tiltDeg: fc.double({ min: 0, max: 89, noNaN: true }),
      viewMode: fc.constantFrom('auto' as const, '2d' as const, 'manual' as const),
      chosenTiltDeg: fc.double({ min: 0, max: 89, noNaN: true }),
      chosenHeadingDeg: fc.double({ min: 0, max: 360, maxExcluded: true, noNaN: true }),
    },
    { requiredKeys: ['longitudeDeg', 'latitudeDeg', 'zoom', 'headingDeg', 'tiltDeg', 'viewMode'] },
  );

  test.prop([view])('round-trips exactly through JSON and URLs', (state) => {
    // JSON has no negative zero: -0 reads back as 0, the same camera.
    const expected = Object.fromEntries(
      Object.entries(state).map(([key, value]) => [key, Object.is(value, -0) ? 0 : value]),
    );
    expect(viewStateFromJson(viewStateToJson(state))).toEqual(expected);
    expect(viewStateFromUrl(viewStateToUrl('https://example.org/map?x=1#layer=a', state))).toEqual(expected);
  });

  it('keeps the URL and the fragment’s other parameters', () => {
    const url = viewStateToUrl('https://example.org/map?x=1#layer=a', VIEW);
    expect(url).toBe(
      'https://example.org/map?x=1#layer=a&view=14.123456789/45.4642/9.190000000000001/33.3/52.5/auto/60',
    );
  });

  it('clamps and wraps out-of-range values', () => {
    expect(viewStateFromFragment('40/95/190/-30/120/3d')).toEqual({
      zoom: 28,
      latitudeDeg: 90,
      longitudeDeg: -170,
      headingDeg: 330,
      tiltDeg: 89,
      viewMode: 'manual',
    });
  });

  it.each([
    '',
    '1/2/3/4/5',
    '1/2/3/4/5/flat',
    '1/2/3/4/x/auto',
    '1/2/3/4/5/auto/7/8/9',
    '1/2/Infinity/4/5/auto',
    '1/2/3/4/5/auto/NaN',
    '0x10/2/3/4/5/auto',
  ])('rejects the malformed fragment %j', (fragment) => {
    expect(viewStateFromFragment(fragment)).toBeUndefined();
  });

  it.each([
    'not json',
    'null',
    '[]',
    '{"version":3,"longitudeDeg":0,"latitudeDeg":0,"zoom":1,"headingDeg":0,"tiltDeg":0,"viewMode":"auto"}',
    '{"version":1,"longitudeDeg":"0","latitudeDeg":0,"zoom":1,"headingDeg":0,"tiltDeg":0,"viewMode":"auto"}',
    '{"version":1,"latitudeDeg":0,"zoom":1,"headingDeg":0,"tiltDeg":0,"viewMode":"auto"}',
  ])('rejects the malformed JSON %j', (json) => {
    expect(viewStateFromJson(json)).toBeUndefined();
  });

  it('reads views written with version 1, whose manual mode was "3d"', () => {
    const json = '{"version":1,"longitudeDeg":1,"latitudeDeg":2,"zoom":3,"headingDeg":4,"tiltDeg":5,"viewMode":"3d"}';
    expect(viewStateFromJson(json)?.viewMode).toBe('manual');
  });

  it('reads a globe camera, or nothing while it waits for a viewport', () => {
    const camera = {
      longitudeDeg: 7,
      latitudeDeg: 45,
      zoom: 11,
      headingDeg: 20,
      tiltDeg: 30,
      viewMode: 'manual',
      chosenTiltDeg: 50,
      chosenHeadingDeg: 20,
    } as CameraState;
    expect(viewStateOf(camera)).toEqual({ ...camera });
    expect(viewStateOf({ ...camera, zoom: NaN })).toBeUndefined();
  });

  it('rejects URLs without a view', () => {
    expect(viewStateFromUrl('not a url')).toBeUndefined();
    expect(viewStateFromUrl('https://example.org/#layer=a')).toBeUndefined();
  });
});
