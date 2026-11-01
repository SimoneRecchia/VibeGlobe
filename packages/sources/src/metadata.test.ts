import { describe, expect, it } from 'vitest';
import { combineProfiles, type ProviderProfile } from './metadata.js';

const profile = (id: string, rules: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id,
  forbids: new Set(),
  respectCacheHeaders: false,
  ...rules,
});

describe('combineProfiles', () => {
  it('keeps every rule of both: drawing only and the terms warnings too (KB-328)', () => {
    const terms = profile('terms', { displayOnly: true, warning: 'Drawing only.' });
    const app = profile('app', { warning: 'Keep the credit visible.', maxConcurrentRequests: 4 });
    for (const combined of [combineProfiles(terms, app), combineProfiles(app, terms)]) {
      expect(combined.displayOnly).toBe(true);
      expect(combined.warning).toContain('Drawing only.');
      expect(combined.warning).toContain('Keep the credit visible.');
      expect(combined.maxConcurrentRequests).toBe(4);
    }
  });
});
