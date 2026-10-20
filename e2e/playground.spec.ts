import { expect, test } from '@playwright/test';

test('playground loads without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/');

  await expect(page).toHaveTitle('VibeGlobeEngine playground');
  await expect(page.locator('#status')).toContainText('WGS84, a = 6378137 m');
  expect(errors).toEqual([]);
});
