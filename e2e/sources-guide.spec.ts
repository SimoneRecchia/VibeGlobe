// The documentation site publishes the sources guide with a section for every topic (F268); its examples run as tests
// in scripts/integration/sources-guide.test.ts.
import { expect, test } from '@playwright/test';

test('the documentation site publishes the sources guide with every section (F268)', async ({ page }) => {
  await page.goto(`http://localhost:${process.env['DOCS_PORT'] ?? 5174}/documents/Sources_and_adapters.html`);
  await expect(page.getByRole('heading', { name: 'Sources and adapters', level: 1 })).toBeVisible();
  for (const section of [
    'The adapter interface',
    'Imagery adapters',
    'Terrain adapters',
    'Vector tiles in packages',
    'Reprojection',
    'Layer composition and source chains',
    'Vector formats',
    'Provider profiles',
    'Keeping secrets out of URLs',
    'Writing and testing a custom adapter',
  ])
    await expect(page.getByRole('heading', { level: 2, name: section })).toBeVisible();
  for (const section of ["Your own provider's profile", 'Commercial providers, from your own code', 'Apple map data'])
    await expect(page.getByRole('heading', { level: 3, name: section })).toBeVisible();
  await expect(page.getByText("Apple's map data may only be used through Apple's own MapKit")).toBeVisible();
});
