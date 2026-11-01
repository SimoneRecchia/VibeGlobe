import { describe, expect, it } from 'vitest';
import { onlineImagery } from './online-imagery.js';

describe('online imagery of your choice (F683)', () => {
  it('adds nothing without a URL, and the URL with its required credit from level 12 to 19, online only', () => {
    expect(onlineImagery({})).toBeUndefined();
    const added = onlineImagery({
      VITE_ONLINE_IMAGERY_URL: 'https://tiles.provider.test/{z}/{x}/{y}.jpg?key=k',
      VITE_ONLINE_IMAGERY_CREDIT: '© Provider',
    });
    expect(added?.source).toMatchObject({
      id: 'online-imagery',
      minLevel: 12,
      maxLevel: 19,
      profile: { requiredAttribution: { text: '© Provider' } },
    });
    expect(added?.record).toMatchObject({
      tiers: 'network',
      coverage: 'world',
      termsUrl: 'https://tiles.provider.test',
    });
    expect(
      onlineImagery({ VITE_ONLINE_IMAGERY_URL: 'https://tiles.provider.test/{z}/{x}/{y}.jpg' })?.record.attribution,
    ).toEqual([{ text: 'tiles.provider.test' }]);
  });
});
