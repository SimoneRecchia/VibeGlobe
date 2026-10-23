import type { IncomingMessage, ServerResponse } from 'node:http';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { FixtureServer } from './server.ts';
import { MARKER_RGB, parseUtmRequest, renderUtmImage, utmForward, utmInverse } from './utm.ts';

describe('UTM fixture imagery (F226)', () => {
  it('projects like Karney’s reference values within 1 mm and inverts within 1e-9°', () => {
    // GeographicLib's TMcoords.dat: latitude, longitude from the central meridian, x and y in meters (k0 = 0.9996).
    const [lat, dLon, x, y] = [42.640218672601, 0.572483009384, 46933.5388065, 4721021.784855];
    const [easting, northing] = utmForward(9 + dLon, lat, 32);
    expect(Math.abs(easting - (500000 + x))).toBeLessThan(0.001);
    expect(Math.abs(northing - y)).toBeLessThan(0.001);
    const [lon2, lat2] = utmInverse(easting, northing, 32);
    expect(Math.abs(lon2 - (9 + dLon))).toBeLessThan(1e-9);
    expect(Math.abs(lat2 - lat)).toBeLessThan(1e-9);
  });

  it('centres a magenta marker on the pixel where a degree crossing projects', () => {
    const [cx, cy] = utmForward(12, 42, 33);
    const request = parseUtmRequest(
      new URLSearchParams(`crs=EPSG:32633&bbox=${cx - 3000},${cy - 2000},${cx + 3000},${cy + 2000}&width=60&height=40`),
    );
    if (!request) throw new Error('rejected');
    const rgba = renderUtmImage(request);
    let [sumI, sumJ, count] = [0, 0, 0];
    for (let k = 0; k < rgba.length; k += 4) {
      if (rgba[k] !== MARKER_RGB[0] || rgba[k + 1] !== MARKER_RGB[1] || rgba[k + 2] !== MARKER_RGB[2]) continue;
      sumI += ((k / 4) % 60) + 0.5;
      sumJ += Math.floor(k / 4 / 60) + 0.5;
      count++;
    }
    // 100 m per pixel: the crossing projects to the image centre (30, 20).
    expect(count).toBe(81);
    expect(Math.abs(sumI / count - 30)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(sumJ / count - 20)).toBeLessThanOrEqual(0.5);
  });

  it('is served as a PNG GetMap answer and logged in the session', () => {
    const server = new FixtureServer(() => 0);
    let status = 0;
    let body: Buffer = Buffer.alloc(0);
    const res = {
      writeHead(code: number) {
        status = code;
        return this;
      },
      end(data: Buffer) {
        body = data;
      },
    } as unknown as ServerResponse;
    const req = {
      url: '/fixture-tiles/s1/wms-utm?SERVICE=WMS&REQUEST=GetMap&CRS=EPSG%3A32632&BBOX=700000,4700000,710000,4710000&WIDTH=16&HEIGHT=8',
      headers: {},
      socket: {},
    } as unknown as IncomingMessage;
    server.middleware(req, res, () => undefined);
    expect(status).toBe(200);
    expect(PNG.sync.read(body).width).toBe(16);
    let log = '';
    const logRes = { writeHead: () => logRes, end: (data: string) => (log = data) } as unknown as ServerResponse;
    server.middleware(
      { url: '/_fixture/s1/log', method: 'GET', headers: {} } as IncomingMessage,
      logRes,
      () => undefined,
    );
    expect(JSON.parse(log)).toMatchObject([{ source: 'wms-utm', status: 200 }]);
  });
});
