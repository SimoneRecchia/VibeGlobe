// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Small sample documents of the Files scene: rough outlines of three lakes, huts and a trail, a hiking track. */

const ring = (points: string): number[][] => points.split(' ').map((pair) => pair.split(',').map(Number));

/** One sample per format, as the files would hold them. */
export const SAMPLES = {
  geojson: JSON.stringify({
    type: 'FeatureCollection',
    features: [
      ['Lago di Garda', '10.52,45.43 10.71,45.46 10.73,45.6 10.87,45.85 10.84,45.87 10.62,45.62 10.52,45.43'],
      ['Lago di Como', '9.06,45.82 9.27,45.84 9.42,46.15 9.36,46.17 9.24,45.95 9.1,45.86 9.06,45.82'],
      ['Lago Maggiore', '8.54,45.75 8.63,45.8 8.72,46.1 8.86,46.17 8.79,46.19 8.6,45.93 8.54,45.75'],
    ].map(([name = '', outline = '']) => ({
      type: 'Feature',
      properties: { name },
      geometry: { type: 'Polygon', coordinates: [ring(outline)] },
    })),
  }),
  kml: `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><name>Rifugio Torino</name><Point><coordinates>6.9339,45.8433,3375</coordinates></Point></Placemark>
<Placemark><name>Refuge du Goûter</name><Point><coordinates>6.8297,45.8506,3835</coordinates></Point></Placemark>
<Placemark><name>Rifugio Elisabetta</name><Point><coordinates>6.8222,45.7778,2195</coordinates></Point></Placemark>
<Placemark><name>Val Veny trail</name><LineString><coordinates>6.8222,45.7778 6.85,45.785 6.88,45.79 6.91,45.8 6.95,45.81</coordinates></LineString></Placemark>
</Document></kml>`,
  gpx: `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="vibeglobe" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>Chamonix to Lac Blanc</name><trkseg>${ring(
    '6.8694,45.9237,1035 6.8655,45.9302,1180 6.8602,45.9351,1420 6.857,45.938,1990 6.8611,45.9477,2100 ' +
      '6.8692,45.9566,2130 6.8762,45.9653,2220 6.8818,45.9742,2310 6.8865,45.9814,2352',
  )
    .map(([lon, lat, ele]) => `<trkpt lat="${String(lat)}" lon="${String(lon)}"><ele>${String(ele)}</ele></trkpt>`)
    .join('')}</trkseg></trk></gpx>`,
} as const;
