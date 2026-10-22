import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTool } from './docker.js';

const IMAGE = `docker.io/osgeo/gdal:ubuntu-small-3.6.3@sha256:${'0'.repeat(64)}`;

describe('runTool', () => {
  it('refuses an image that is not pinned by digest', () => {
    expect(() => runTool({ image: 'osgeo/gdal:latest', folder: '/tmp', command: ['gdalinfo'] })).toThrow(
      /pinned by digest/,
    );
  });

  it('runs without network, as the current user, with only the build folder mounted (DP-001: absolute mount path)', () => {
    let args: string[] = [];
    const spawn = ((_cmd: string, a: string[]) => {
      args = a;
      return { status: 0, stdout: 'ok', stderr: '' };
    }) as unknown as Parameters<typeof runTool>[2];
    expect(runTool({ image: IMAGE, folder: 'build/a', command: ['gdalinfo', 'x.tif'] }, undefined, spawn)).toBe('ok');
    expect(args).toContain('none');
    expect(args[args.indexOf('-v') + 1]).toBe(`${resolve('build/a')}:/work`);
    expect(args.slice(-3)).toEqual([IMAGE, 'gdalinfo', 'x.tif']);
  });
});
