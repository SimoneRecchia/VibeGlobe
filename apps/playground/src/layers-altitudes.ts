import { DataLayer, type Feature, type Geometry } from '@vibeglobe/layers';
import { ModelLayer } from '@vibeglobe/layers/models';

function feature(id: string, geometry: Geometry): Feature {
  return { type: 'Feature', id, properties: {}, geometry };
}

/**
 * `?scenario=data-altitudes-all` (F362): points as in `data-altitudes`, and markers, lines and glTF models (with
 * {@link altitudeModels}) at 0, 1,000 and 10,000 m.
 */
export function allAltitudeLayers(): DataLayer[] {
  return [0, 1000, 10_000].flatMap((altitude, i) => {
    const lon = 12.5 + i * 0.05;
    const placement = { absoluteAltitudeMeters: altitude };
    return [
      new DataLayer('point', {
        id: `altitude-${String(altitude)}`,
        data: [feature(`a${String(i)}`, { type: 'Point', coordinates: [lon, 41.9] })],
        placement,
        style: { 'circle-color': '#ff2020', 'circle-radius': 5 },
      }),
      new DataLayer('marker', {
        id: `altitude-marker-${String(altitude)}`,
        data: [feature(`m${String(i)}`, { type: 'Point', coordinates: [lon, 41.93] })],
        placement,
        style: { 'icon-image': 'square', 'icon-size': 12 },
      }),
      new DataLayer('polyline', {
        id: `altitude-line-${String(altitude)}`,
        data: [
          feature(`l${String(i)}`, {
            type: 'LineString',
            coordinates: [
              [lon - 0.01, 41.87],
              [lon + 0.01, 41.87],
            ],
          }),
        ],
        placement,
        style: { 'line-color': '#20c040', 'line-width': 5 },
      }),
    ];
  });
}

/** The glTF models of `?scenario=data-altitudes-all` (F362): the pyramid, 600 m across, at 0, 1,000 and 10,000 m. */
export function altitudeModels(): ModelLayer {
  return new ModelLayer({
    id: 'altitude-models',
    models: [0, 1000, 10_000].map((altitude, i) => ({
      id: `p${String(i)}`,
      url: `${import.meta.env.BASE_URL}models/pyramid.gltf`,
      position: { longitudeDeg: 12.5 + i * 0.05, latitudeDeg: 41.84, heightMeters: altitude },
      scale: 300,
    })),
  });
}
