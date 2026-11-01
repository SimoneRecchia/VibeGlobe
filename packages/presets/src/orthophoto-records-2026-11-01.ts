// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The orthophoto services whose terms were read on 2026-11-01 (ADR 0182, its amendment of that day). */
import { ortho, type OrthophotoRecord } from './orthophoto-records.js';

/** The third reading of the providers' terms. */
const THIRD_READING = '2026-11-01';

/** The services of the third reading. */
export const THIRD_READING_ORTHOPHOTOS: readonly OrthophotoRecord[] = [
  ortho({
    id: 'it-bologna-2026',
    name: 'Ortofoto 2026, Comune di Bologna (Bologna)',
    license: 'CC BY 4.0 (the city tile server specification; its open data page names ODbL)',
    termsUrl:
      'https://opendata.comune.bologna.it/api/datasets/1.0/tile-server-ortofoto-comune-di-bologna/attachments/guida_specifiche_tileserver_pdf/',
    attribution: [
      {
        text: '© Comune di Bologna, Ortofoto 2026',
        url: 'https://opendata.comune.bologna.it/explore/dataset/tile-server-ortofoto-comune-di-bologna/',
      },
    ],
    maxLevel: 21,
    regions: [],
    box: [11.229, 44.421, 11.434, 44.557],
    termsReadDate: THIRD_READING,
    service: { kind: 'xyz', url: 'https://sitmappe.comune.bologna.it/tms/tileserver/Ortofoto2026/{z}/{x}/{y}.png' },
  }),
  ortho({
    id: 'sk-gku-ortofoto',
    name: 'GKÚ Ortofotomozaika SR (Slovakia)',
    license: 'CC BY 4.0',
    termsUrl: 'https://www.gku.sk/gku/produkty-sluzby/zbgis/wms.html',
    attribution: [{ text: '© GKÚ Bratislava, NLC, Ortofotomozaika SR, CC BY 4.0', url: 'https://www.geoportal.sk' }],
    maxLevel: 19,
    regions: ['SK'],
    termsReadDate: THIRD_READING,
    service: { kind: 'wms', url: 'https://zbgisws.skgeodesy.sk/zbgis_ortofoto_wms/service.svc/get', layer: '1' },
  }),
  ortho({
    id: 'de-hb-dop20',
    name: 'Landesamt GeoInformation Bremen DOP20 2023 (Bremen and Bremerhaven)',
    license: 'CC BY 4.0',
    termsUrl: 'https://gdk.gdi-de.org/geonetwork/srv/api/records/1BFC8279-364D-47FF-B59B-C7D37C5A6BB8',
    attribution: [{ text: '© GeoBasis-DE / Landesamt GeoInformation Bremen (2023), CC BY 4.0' }],
    maxLevel: 19,
    regions: ['DE-HB'],
    termsReadDate: THIRD_READING,
    service: {
      kind: 'wms',
      url: 'https://geodienste.bremen.de/wms_dop20_2023',
      layer: 'DOP20_2023_HB,DOP20_2023_BHV',
    },
  }),
];
