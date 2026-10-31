// @vitest-environment happy-dom
import type { Globe } from '@vibeglobe/core';
import { describe, expect, it, vi } from 'vitest';
import { ElementUi } from './ui-layer.js';

const createUi = vi.fn(() => ({ element: document.createElement('div'), destroy: vi.fn() }));
vi.mock('@vibeglobe/ui', () => ({ createUi, addDefaultControls: vi.fn(), addAllControls: vi.fn() }));

describe('the element UI layer', () => {
  it('builds no controls when the element is removed while the UI loads (its globe is already destroyed)', async () => {
    const host = document.createElement('div');
    host.setAttribute('ui', 'default');
    const layer = new ElementUi(host, {} as Globe, document.createElement('div'));
    layer.sync();
    layer.stop();
    await expect(layer.ui).rejects.toThrow(/removed/);
    expect(createUi).not.toHaveBeenCalled();
  });
});
