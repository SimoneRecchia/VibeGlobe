// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The Imagery chapter's offline scenes: the adapters, each on tiles the playground's fixture server cuts from the
 * Natural Earth image in its own tone (`scripts/fixtures/tiles/earth.ts`), and the composition of layers and chains.
 */
import type { GeoBounds, ImagerySource } from '@vibeglobe/core';
import { transformCoordinates } from '@vibeglobe/gis';
import {
  pmtilesImagery,
  reprojectedImagery,
  singleImage,
  wmsGetMapUrl,
  wmtsImagery,
  xyzImagery,
} from '@vibeglobe/sources';
import type { SceneContext, SceneModule } from '../types.js';

const FIXTURE = `${location.origin}${import.meta.env.BASE_URL}fixture-tiles/showcase/`;
const DEG = 180 / Math.PI;
const credit = (text: string): { attribution: { text: string }[] } => ({ attribution: [{ text }] });

/** WMTS capabilities of the fixture's tiles in Web Mercator, levels 0 to 14, as a service would publish them. */
function capabilities(pattern: string): string {
  const matrices = Array.from(
    { length: 15 },
    (_, z) =>
      `<TileMatrix><ows:Identifier>${String(z)}</ows:Identifier><ScaleDenominator>${String(559_082_264.0287178 / 2 ** z)}</ScaleDenominator>` +
      `<TopLeftCorner>-20037508.3427892 20037508.3427892</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight>` +
      `<MatrixWidth>${String(2 ** z)}</MatrixWidth><MatrixHeight>${String(2 ** z)}</MatrixHeight></TileMatrix>`,
  ).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Capabilities xmlns="http://www.opengis.net/wmts/1.0" ' +
    'xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0"><Contents><Layer><ows:Title>Marble</ows:Title>' +
    '<ows:Identifier>marble</ows:Identifier><ows:WGS84BoundingBox><ows:LowerCorner>-25 34</ows:LowerCorner>' +
    '<ows:UpperCorner>45 72</ows:UpperCorner></ows:WGS84BoundingBox><Style isDefault="true"><ows:Identifier>default' +
    '</ows:Identifier></Style><Format>image/png</Format><TileMatrixSetLink><TileMatrixSet>mercator</TileMatrixSet>' +
    `</TileMatrixSetLink><ResourceURL format="image/png" resourceType="tile" template="${FIXTURE}${pattern}/mercator/` +
    '{TileMatrix}/{TileCol}/{TileRow}.png"/></Layer><TileMatrixSet><ows:Identifier>mercator</ows:Identifier>' +
    `<ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>${matrices}</TileMatrixSet></Contents></Capabilities>`
  );
}

/** The fixture's UTM 32N service, reprojected on the client into the globe's tiles. */
function utmService(): ImagerySource {
  const crs = 'EPSG:32632';
  return reprojectedImagery({
    id: 'adapter-wms',
    sourceCrs: crs,
    toSource: (lon, lat) => {
      const p = transformCoordinates({ x: lon, y: lat }, 'EPSG:4326', crs);
      return [p.x, p.y];
    },
    fromSource: (x, y) => {
      const p = transformCoordinates({ x, y }, crs, 'EPSG:4326');
      return [p.x, p.y];
    },
    bounds: [250_000, 4_250_000, 760_000, 5_250_000],
    image: (bbox, widthPx, heightPx) =>
      wmsGetMapUrl(`${FIXTURE}wms-utm`, { layers: ['utm'], crs, bbox, widthPx, heightPx }),
    ...credit('Fixture WMS in UTM 32N'),
  });
}

/** A weather-radar-like picture drawn on a canvas, as a PNG. */
async function radarImage(): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('no 2D canvas');
  for (const [x, y, r, color] of [
    [180, 240, 170, '0 160 255'],
    [300, 280, 120, '0 220 120'],
    [330, 250, 60, '255 200 0'],
    [345, 245, 26, '255 60 40'],
  ] as const) {
    const fill = g.createRadialGradient(x, y, 0, x, y, r);
    fill.addColorStop(0, `rgb(${color} / 0.85)`);
    fill.addColorStop(1, `rgb(${color} / 0)`);
    g.fillStyle = fill;
    g.fillRect(0, 0, 512, 512);
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no PNG'))), 'image/png'),
  );
}

/** The bounds of a source's coverage, degrees, when it declares one. */
function boundsOf(source: ImagerySource): GeoBounds | undefined {
  const box = source.coverage?.[0];
  return (
    box && {
      westDeg: box.westRad * DEG,
      southDeg: box.southRad * DEG,
      eastDeg: box.eastRad * DEG,
      northDeg: box.northRad * DEG,
    }
  );
}

/** A source from a dropped file: PMTiles, GeoTIFF, or an image placed over the view. */
function fileSource(file: File, context: SceneContext): Promise<ImagerySource> {
  const id = 'adapter-file';
  if (/\.pmtiles$/i.test(file.name)) return pmtilesImagery({ id, archive: file });
  if (/\.tiff?$/i.test(file.name))
    return import('@vibeglobe/sources/geotiff').then((m) => m.geotiffImage({ id, image: file }));
  const box = context.container.getBoundingClientRect();
  const nw = context.globe.screenToGeo({ xPx: box.width * 0.25, yPx: box.height * 0.25 });
  const se = context.globe.screenToGeo({ xPx: box.width * 0.75, yPx: box.height * 0.75 });
  if (!nw || !se) throw new Error('the middle of the view is off the globe');
  return singleImage({ id, image: file, bounds: [nw.longitudeDeg, se.latitudeDeg, se.longitudeDeg, nw.latitudeDeg] });
}

type Adapter = 'xyz' | 'wmts' | 'wms' | 'image';

/** The source of each offline adapter. */
const ADAPTERS: Readonly<Record<Adapter, () => Promise<ImagerySource>>> = {
  xyz: async () =>
    xyzImagery({
      id: 'adapter-xyz',
      url: `${FIXTURE}earth-package/mercator/{z}/{x}/{y}.png`,
      maxLevel: 14,
      area: await (await import('@vibeglobe/presets/countries')).countryBorders('FR'),
      ...credit('Fixture XYZ tiles'),
    }),
  wmts: () =>
    wmtsImagery({
      id: 'adapter-wmts',
      capabilities: capabilities('earth-marble'),
      layer: 'marble',
      ...credit('Fixture WMTS'),
    }),
  wms: async () => utmService(),
  image: async () =>
    singleImage({
      id: 'adapter-image',
      image: await radarImage(),
      bounds: [5.5, 43.3, 13.5, 48.2],
      ...credit('A generated image'),
    }),
};

/** One adapter at a time, as the top imagery layer. */
export const adapters: SceneModule = {
  code: `import { singleImage, wmtsImagery, xyzImagery } from '@vibeglobe/sources';

globe.imageryLayers.add(xyzImagery({ id: 'tiles', url: 'https://tiles.example.com/{z}/{x}/{y}.png' }));
globe.imageryLayers.add(await wmtsImagery({ id: 'ortho', capabilities: wmtsUrl, layer: 'ortho' }));
globe.imageryLayers.add(
  await singleImage({ id: 'radar', image: 'radar.png', bounds: [5.5, 43.3, 13.5, 48.2] }),
);`,
  start(context) {
    const { globe, panel } = context;
    context.go({ longitudeDeg: 8, latitudeDeg: 46, zoom: 4.6, headingDeg: 0, tiltDeg: 0 });
    let shown: string | undefined;
    const readout = panel.readout();
    const show = async (make: () => Promise<ImagerySource>): Promise<void> => {
      if (shown) globe.imageryLayers.remove(shown);
      shown = undefined;
      try {
        const source = await make();
        if (context.signal.aborted) return;
        globe.imageryLayers.add(source);
        shown = source.id;
        readout([
          ['Layer', source.id],
          ['Levels', `${String(source.minLevel)} to ${String(source.maxLevel)}`],
          ['Credit', source.attribution?.map((a) => a.text).join(', ') ?? '—'],
        ]);
        const bounds = boundsOf(source);
        if (source.id === 'adapter-file' && bounds) void globe.fitBounds(bounds, { paddingPx: 40 });
      } catch (error) {
        readout([['Error', error instanceof Error ? error.message : String(error)]]);
      }
    };
    context.defer(() => shown !== undefined && globe.imageryLayers.remove(shown));
    const notes: Record<Adapter, string> = {
      xyz: 'An XYZ template, its tiles clipped to the borders of France from the presets.',
      wmts: 'WMTS capabilities read from XML: the layer, its tile matrix set and its RESTful template.',
      wms: 'A WMS in UTM zone 32N (EPSG:32632), warped into the globe’s tiles on the client.',
      image: 'One PNG placed by its bounds, cut into tiles in memory.',
    };
    const note = panel.note('');
    const pick = (adapter: Adapter): void => {
      note.textContent = notes[adapter];
      void show(ADAPTERS[adapter]);
    };
    panel.choice(
      'Adapter',
      [
        ['xyz', 'XYZ'],
        ['wmts', 'WMTS'],
        ['wms', 'WMS · UTM'],
        ['image', 'Image'],
      ],
      'xyz',
      pick,
    );
    pick('xyz');
    panel.files(
      'Your own file',
      '.pmtiles,.tif,.tiff,.png,.jpg,.jpeg,.webp',
      (file) => void show(() => fileSource(file, context)),
    );
  },
};

/** A layer over a chain of two sources, and an overlay with opacity and blend. */
export const composition: SceneModule = {
  code: `globe.imageryLayers.add({
  id: 'base',
  sources: [italyOrtho, worldTiles], // each tile from the first source that has it
  harmonize: true, // the finer source's tones matched to the coarser one
});
globe.imageryLayers.add({ id: 'tint', sources: [tint], opacity: 0.5, blend: 'multiply' });
globe.imageryLayers.set('tint', { opacity: 0.8, visible: true });
globe.imageryLayers.move('tint', 0);`,
  start(context) {
    const { globe, panel } = context;
    context.go({ longitudeDeg: 12.5, latitudeDeg: 42.5, zoom: 5.2, headingDeg: 0, tiltDeg: 0 });
    const tiles = (pattern: string, maxLevel: number, extra = {}): ImagerySource =>
      xyzImagery({
        id: `chain-${pattern}`,
        url: `${FIXTURE}${pattern}/mercator/{z}/{x}/{y}.png`,
        maxLevel,
        ...credit(`Fixture ${pattern}`),
        ...extra,
      });
    const italy = { westRad: 6.6 / DEG, southRad: 36.6 / DEG, eastRad: 18.5 / DEG, northRad: 47.1 / DEG };
    const chain = {
      id: 'chain',
      sources: [tiles('earth-fine', 14, { coverage: [italy] }), tiles('earth-package', 14)],
      harmonize: false,
    };
    context.imagery(chain);
    const tint = { id: 'tint', sources: [tiles('earth-marble', 14)], opacity: 0.5, blend: 'multiply' as const };
    context.imagery(tint);
    const chainGroup = panel.group('Source chain');
    chainGroup.note(
      'Italy comes from a finer source; the rest of the world from the next source of the chain, in another tone.',
    );
    chainGroup.toggle('Match the tones', false, (harmonize) => globe.imageryLayers.set('chain', { harmonize }));
    const overlay = panel.group('Overlay');
    overlay.toggle('Visible', true, (visible) => globe.imageryLayers.set('tint', { visible }));
    overlay.slider('Opacity', { min: 0, max: 1, step: 0.05, value: 0.5 }, (opacity) =>
      globe.imageryLayers.set('tint', { opacity }),
    );
    overlay.choice(
      'Blend',
      [
        ['normal', 'Normal'],
        ['multiply', 'Multiply'],
        ['screen', 'Screen'],
      ],
      'multiply',
      (blend) => globe.imageryLayers.set('tint', { blend }),
    );
    const readout = panel.readout();
    const update = (): void =>
      readout(
        globe.imageryLayers
          .list()
          .map(
            (layer, index) =>
              [
                `${String(index)} · ${layer.id}`,
                `${layer.visible ? '' : 'hidden · '}${layer.blend} ${layer.opacity.toFixed(2)}`,
              ] as const,
          ),
      );
    context.on('imagery-layers-change', update);
    update();
  },
};
