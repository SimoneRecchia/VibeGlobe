import { expect, test } from '@playwright/test';

const DOCS_URL = `http://localhost:${process.env['DOCS_PORT'] ?? 5174}`;
const PACKAGES = [
  'controls',
  'core',
  'layers',
  'offline',
  'renderer',
  'sources',
  'tools',
  'ui',
  'vue',
  'web-component',
];

test('documentation site serves the guides and the API reference of every package', async ({ page }) => {
  await page.goto(`${DOCS_URL}/modules.html`);
  await expect(page).toHaveTitle(/VibeGlobeEngine/);
  for (const name of PACKAGES) {
    await expect(page.getByRole('link', { name: `@vibeglobe/${name}`, exact: true }).first()).toBeVisible();
  }

  await page.goto(`${DOCS_URL}/classes/_vibeglobe_core.FrameStats.html`);
  await expect(page.getByRole('heading', { name: /FrameStats/ }).first()).toBeVisible();
  await expect(page.getByText('Rolling frame-time statistics over the most recent frames.').first()).toBeVisible();

  await page.goto(`${DOCS_URL}/documents/Development.html`);
  await expect(page.getByRole('heading', { name: 'Development', level: 1 })).toBeVisible();
});
