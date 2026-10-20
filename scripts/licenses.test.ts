import { describe, expect, it } from 'vitest';
import { isLicenseAllowed, licenseViolations, shippedPackages, ALLOWED_LICENSES, type Lockfile } from './licenses.ts';

const lock: Lockfile = {
  packages: {
    '': {},
    'packages/core': {},
    'packages/renderer': { dependencies: { '@vibeglobe/core': '*', three: '1.0.0' } },
    'apps/playground': { dependencies: { leftpad: '1.0.0' } },
    'node_modules/@vibeglobe/core': { link: true, resolved: 'packages/core' },
    'node_modules/three': { version: '1.0.0', license: 'MIT', dependencies: { shared: '2.0.0' } },
    'node_modules/three/node_modules/shared': { version: '2.0.0', license: 'ISC' },
    'node_modules/shared': { version: '1.0.0', license: 'GPL-3.0' },
    'node_modules/leftpad': { version: '1.0.0', license: 'WTFPL' },
    'node_modules/vitest': { version: '5.0.0', license: 'MIT' },
  },
};

describe('shippedPackages', () => {
  it('follows workspace links and nested node_modules, and skips private apps and dev tools', () => {
    expect(shippedPackages(lock, ['packages/core', 'packages/renderer'])).toEqual([
      { name: 'shared', version: '2.0.0', license: 'ISC', path: 'node_modules/three/node_modules/shared' },
      { name: 'three', version: '1.0.0', license: 'MIT', path: 'node_modules/three' },
    ]);
  });
});

describe('isLicenseAllowed', () => {
  it.each([
    'MIT',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'Apache-2.0',
    'ISC',
    '(MIT OR GPL-3.0)',
    'Apache-2.0 WITH LLVM-exception',
    '(MIT AND ISC)',
  ])('allows %s', (license) => expect(isLicenseAllowed(license, ALLOWED_LICENSES)).toBe(true));

  it.each([
    'GPL-3.0',
    'GPL-2.0-only',
    'LGPL-2.1',
    'LGPL-3.0-or-later',
    'AGPL-3.0',
    'MPL-2.0',
    'MIT AND GPL-2.0',
    'UNLICENSED',
    '',
    undefined,
  ])('rejects %s', (license) => expect(isLicenseAllowed(license, ALLOWED_LICENSES)).toBe(false));
});

describe('licenseViolations', () => {
  it('reports disallowed and missing licenses, and allows OFL only for fonts', () => {
    const packages = [
      { name: 'ok', version: '1.0.0', license: 'MIT', path: 'node_modules/ok' },
      { name: 'copyleft', version: '1.0.0', license: 'GPL-3.0', path: 'node_modules/copyleft' },
      { name: 'unknown', version: '1.0.0', license: undefined, path: 'node_modules/unknown' },
      { name: '@fontsource/inter', version: '5.0.0', license: 'OFL-1.1', path: 'node_modules/@fontsource/inter' },
      { name: 'not-a-typeface', version: '1.0.0', license: 'OFL-1.1', path: 'node_modules/not-a-typeface' },
    ];
    expect(licenseViolations(packages)).toEqual([
      'copyleft@1.0.0 (node_modules/copyleft): license "GPL-3.0" is not allowed',
      'unknown@1.0.0 (node_modules/unknown): license "missing" is not allowed',
      'not-a-typeface@1.0.0 (node_modules/not-a-typeface): license "OFL-1.1" is not allowed',
    ]);
  });
});
