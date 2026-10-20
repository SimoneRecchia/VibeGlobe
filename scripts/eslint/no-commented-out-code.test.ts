import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { looksLikeCode, noCommentedOutCode } from './no-commented-out-code.ts';

RuleTester.describe = describe;
RuleTester.it = it;

describe('looksLikeCode', () => {
  it.each([
    'const x = compute(a, b);',
    ' if (ready) { start(); }',
    'return value;',
    'globe.flyTo({ zoom: 3 })',
    "import { a } from './a.js';",
  ])('flags %j', (text) => expect(looksLikeCode(text)).toBe(true));

  it.each([
    'Runs Vite directly (not through npm) so the recorded pid is the server itself.',
    'Cloud containers ship a preinstalled Chromium; init.sh points VGE_CHROMIUM_PATH at it.',
    'Hot path: frame loop',
    'width',
    'eslint-disable-next-line no-console',
    '@ts-expect-error the fixture is deliberately invalid',
    'sse = geometricError · viewportHeightPx / (2 · distance)',
  ])('accepts %j', (text) => expect(looksLikeCode(text)).toBe(false));
});

new RuleTester({ languageOptions: { parser: tseslint.parser } }).run('no-commented-out-code', noCommentedOutCode, {
  valid: [
    '// Explains why the cache is cleared here.\nclear();',
    '/** TSDoc with an example: `globe.flyTo({ zoom: 3 });` */\nexport function f(): void {}',
    '/* Block comment in prose (with parentheses). */\nconst a = 1;',
  ],
  invalid: [
    { code: '// const old = legacy();\nconst a = 1;', errors: [{ messageId: 'commentedOutCode' }] },
    { code: '// if (debug) {\n//   log(state);\n// }\nrun();', errors: [{ messageId: 'commentedOutCode' }] },
    { code: '/* oldPath(x); */\nnewPath(x);', errors: [{ messageId: 'commentedOutCode' }] },
  ],
});
