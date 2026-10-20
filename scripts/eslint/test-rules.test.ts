import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Focused, skipped and conditionally skipped tests must fail the lint in every test runner (KB-005).
const eslint = new ESLint({ cwd: new URL('../..', import.meta.url).pathname });

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

describe('lint rules that keep tests from being skipped or focused (KB-005)', () => {
  it.each([
    ["test.only('a', async () => {});", 'test.only'],
    ["test.describe.only('suite', () => {});", 'test.describe.only'],
    ["test.skip('a', async () => {});", 'test.skip'],
    ["test.fixme('a', async () => {});", 'test.fixme'],
    ["test('a', async () => {\n  test.skip();\n});", 'an in-body test.skip()'],
  ])('rejects %j in Playwright specs (%s)', async (body) => {
    const code = `import { test } from '@playwright/test';\n${body}\n`;
    expect(await ruleIds(code, 'e2e/zz-lint-probe.spec.ts')).not.toEqual([]);
  });

  it('rejects skipped Playwright tests in e2e/*.test.ts files too', async () => {
    const code = "import { test } from '@playwright/test';\ntest.skip('a', async () => {});\n";
    expect(await ruleIds(code, 'e2e/zz-lint-probe.test.ts')).not.toEqual([]);
  });

  it.each([
    "it.concurrent.skipIf(true)('a', () => {});",
    "it.sequential.runIf(false)('a', () => {});",
    "it.skipIf(process.env['CI'])('a', () => {});",
    "it.runIf(process.env['CI'])('a', () => {});",
    "describe.skipIf(true)('suite', () => {});",
    "test.runIf(false)('a', () => {});",
  ])('rejects %j in Vitest tests', async (body) => {
    const code = `import { describe, it, test } from 'vitest';\n${body}\n`;
    expect(await ruleIds(code, 'packages/core/src/zz-lint-probe.test.ts')).not.toEqual([]);
  });

  it.each([
    [
      'e2e/zz-lint-probe.spec.ts',
      "import { test } from '@playwright/test';\ntest('a', async ({ page }, { skip }) => {\n  skip(true);\n  await page.goto('/');\n});\n",
    ],
    [
      'packages/core/src/zz-lint-probe.test.ts',
      "import { test } from 'vitest';\ntest('a', ({ skip }) => {\n  skip(true);\n});\n",
    ],
    [
      'packages/core/src/zz-lint-probe.test.ts',
      "import { test } from 'vitest';\ntest('a', (context) => {\n  context.skip();\n});\n",
    ],
  ])('rejects a skip taken from the test context in %s', async (filePath, code) => {
    expect(await ruleIds(code, filePath)).not.toEqual([]);
  });

  it('accepts ordinary tests', async () => {
    expect(
      await ruleIds(
        "import { test } from '@playwright/test';\ntest('a', async () => {});\n",
        'e2e/zz-lint-probe.spec.ts',
      ),
    ).toEqual([]);
    expect(
      await ruleIds("import { it } from 'vitest';\nit('a', () => {});\n", 'packages/core/src/zz-lint-probe.test.ts'),
    ).toEqual([]);
  });
});
