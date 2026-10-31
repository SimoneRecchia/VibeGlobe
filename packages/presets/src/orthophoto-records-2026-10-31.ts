// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The orthophoto services whose terms were read on 2026-10-31 (ADR 0182, its amendment of that day). */
import { ortho, type OrthophotoRecord, SECOND_READING } from './orthophoto-records.js';

/** The services of the second reading, in the amendment's order. */
export const SECOND_READING_ORTHOPHOTOS: readonly OrthophotoRecord[] = [
  ortho({
    id: 'ign-bd-ortho',
    name: 'IGN BD ORTHO / ORTHO HR (France)',
    license: 'Licence Ouverte Etalab 2.0',
    termsUrl: 'https://geoservices.ign.fr/documentation/donnees/ortho/bdortho',
    attribution: [{ text: '© IGN 2026 – BD ORTHO®', url: 'https://www.ign.fr' }],
    maxLevel: 19,
    regions: ['FR'],
    termsReadDate: SECOND_READING,
    limits: 'the Géoplateforme WMTS is exempt from its rate limits (its WMS is limited to 40 requests a second per IP)',
    service: {
      kind: 'xyz',
      url:
        'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS' +
        '&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
    },
  }),
  ortho({
    id: 'pnoa',
    name: 'PNOA Máxima Actualidad (Spain)',
    license: 'CC BY 4.0 (IGN / CNIG conditions, Orden FOM/2807/2015)',
    termsUrl: 'https://www.ign.es/resources/licencia/Condiciones_licenciaUso_IGN.pdf',
    attribution: [{ text: 'PNOA-MA CC-BY 4.0 scne.es 2026', url: 'https://www.scne.es' }],
    maxLevel: 20,
    regions: ['ES'],
    termsReadDate: SECOND_READING,
    service: {
      kind: 'xyz',
      url:
        'https://www.ign.es/wmts/pnoa-ma?request=GetTile&service=WMTS&VERSION=1.0.0&Layer=OI.OrthoimageCoverage' +
        '&Style=default&Format=image/jpeg&TileMatrixSet=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}',
    },
  }),
  ortho({
    id: 'pdok-luchtfoto',
    name: 'PDOK Luchtfoto, Beeldmateriaal Nederland (Netherlands)',
    license: 'CC BY 4.0',
    termsUrl: 'https://www.beeldmateriaal.nl/dataroom',
    attribution: [{ text: 'Beeldmateriaal.nl, CC BY 4.0', url: 'https://www.beeldmateriaal.nl' }],
    maxLevel: 21,
    regions: ['NL'],
    termsReadDate: SECOND_READING,
    service: {
      kind: 'xyz',
      url:
        'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
        '&LAYER=Actueel_orthoHR&STYLE=&FORMAT=image/jpeg&tileMatrixSet=OGC:1.0:GoogleMapsCompatible' +
        '&tileMatrix={z}&tileRow={y}&tileCol={x}',
    },
  }),
  ortho({
    id: 'be-vlg-omw',
    name: 'Digitaal Vlaanderen Orthofotomozaïek, winter, most recent (Flanders)',
    license: 'Vlaamse Open Data licentie v1.2',
    termsUrl: 'https://www.vlaanderen.be/digitaal-vlaanderen/nieuws/release-orthofotomozaiek-middenschalig-2025',
    attribution: [
      {
        text: 'Bron: Orthofotomozaïek Vlaanderen 2025, Digitaal Vlaanderen',
        url: 'https://www.vlaanderen.be/digitaal-vlaanderen',
      },
    ],
    maxLevel: 21,
    regions: ['BE-VLG'],
    termsReadDate: SECOND_READING,
    service: {
      kind: 'xyz',
      url:
        'https://geo.api.vlaanderen.be/OMWRGBMRVL/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=omwrgbmrvl' +
        '&STYLE=&FORMAT=image/png&tileMatrixSet=GoogleMapsVL&tileMatrix={z}&tileRow={y}&tileCol={x}',
    },
  }),
  ortho({
    id: 'be-wal-ortho-last',
    name: 'SPW Orthophotos, most recent (Wallonia)',
    license: 'CC BY 4.0',
    termsUrl: 'https://geoportail.wallonie.be/catalogue/dfc9f3a2-adff-4b7f-ab77-8a890c4cabbb.html',
    attribution: [{ text: '© SPW 2023', url: 'https://geoportail.wallonie.be' }],
    maxLevel: 19,
    regions: ['BE-WAL'],
    termsReadDate: SECOND_READING,
    limits: 'the SPW may change the access conditions of its services without notice',
    service: {
      kind: 'wms',
      url: 'https://geoservices.wallonie.be/arcgis/services/IMAGERIE/ORTHO_LAST/MapServer/WMSServer',
      layer: '0',
    },
  }),
  ortho({
    id: 'lu-act-ortho',
    name: 'ACT BD-L-ORTHO, most recent (Luxembourg)',
    license: 'CC0 1.0 (no credit required)',
    termsUrl: 'https://data.public.lu/en/datasets/bd-l-ortho-webservices-wms-et-wmts',
    attribution: [{ text: 'Administration du cadastre et de la topographie (ACT)', url: 'https://www.geoportail.lu' }],
    maxLevel: 20,
    regions: ['LU'],
    termsReadDate: SECOND_READING,
    service: {
      kind: 'xyz',
      url: 'https://wmts.geoportail.lu/opendata/wmts/ortho_latest/GLOBAL_WEBMERCATOR_4_V3/{z}/{x}/{y}.jpeg',
    },
  }),
  ortho({
    id: 'alto-adige-2023',
    name: 'Ortofoto 2023, Provincia autonoma di Bolzano (Alto Adige / Südtirol)',
    license: 'CC BY 4.0',
    termsUrl: 'https://geonetwork1.civis.bz.it/geonetwork/srv/api/records/p_bz:Orthoimagery:Aerial-2023-RGB',
    attribution: [{ text: '© Provincia autonoma di Bolzano – Alto Adige, Ortofoto 2023, CC BY 4.0' }],
    maxLevel: 19,
    regions: ['IT-BZ'],
    termsReadDate: SECOND_READING,
    service: {
      kind: 'wms',
      url: 'https://geoservices.buergernetz.bz.it/mapproxy/p_bz-Orthoimagery/wms',
      layer: 'Aerial-2023-RGB',
    },
  }),
  ortho({
    id: 'de-by-dop20',
    name: 'Bayerische Vermessungsverwaltung DOP20 (Bayern)',
    license: 'CC BY 4.0',
    termsUrl: 'https://geodatenonline.bayern.de/geodatenonline/seiten/wms_dop20cm',
    attribution: [
      {
        text: 'Datenquelle: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de',
        url: 'https://www.geodaten.bayern.de',
      },
    ],
    maxLevel: 19,
    regions: ['DE-BY'],
    termsReadDate: SECOND_READING,
    service: { kind: 'wms', url: 'https://geoservices.bayern.de/od/wms/dop/v1/dop20', layer: 'by_dop20c' },
  }),
  ortho({
    id: 'de-he-dop20',
    name: 'HVBG DOP20 (Hessen)',
    license: 'Datenlizenz Deutschland – Zero – Version 2.0 (no credit required)',
    termsUrl: 'https://gdk.gdi-de.org/geonetwork/srv/api/records/0b30f537-3bd0-44d4-83b0-e3c1542ca265',
    attribution: [{ text: 'Geobasisdaten © Hessische Verwaltung für Bodenmanagement und Geoinformation' }],
    maxLevel: 19,
    regions: ['DE-HE'],
    termsReadDate: SECOND_READING,
    service: {
      kind: 'wms',
      url: 'https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows',
      layer: 'he_dop20_rgb',
    },
  }),
  ortho({
    id: 'de-sn-dop20',
    name: 'GeoSN DOP20 (Sachsen)',
    license: 'Datenlizenz Deutschland – Namensnennung – Version 2.0',
    termsUrl: 'https://gdk.gdi-de.org/geonetwork/srv/api/records/2B84C9B8-441C-458F-B1D1-7DA8F22B7057',
    attribution: [{ text: 'Geodaten Sachsen, dl-de/by-2-0' }],
    maxLevel: 19,
    regions: ['DE-SN'],
    termsReadDate: SECOND_READING,
    service: { kind: 'wms', url: 'https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest', layer: 'sn_dop_020' },
  }),
  ortho({
    id: 'de-hh-dop20',
    name: 'LGV DOP20, summer (Hamburg)',
    license: 'Datenlizenz Deutschland – Namensnennung – Version 2.0',
    termsUrl: 'https://inspire-geoportal.ec.europa.eu/srv/api/records/5A0265FC-A307-4C71-AB62-F65E8C12E68B',
    attribution: [
      { text: 'Freie und Hansestadt Hamburg, Landesbetrieb Geoinformation und Vermessung (LGV), dl-de/by-2-0' },
    ],
    maxLevel: 19,
    regions: ['DE-HH'],
    termsReadDate: SECOND_READING,
    service: {
      kind: 'wms',
      url: 'https://geodienste.hamburg.de/wms_dop_zeitreihe_belaubt',
      layer: 'dop_zeitreihe_belaubt',
    },
  }),
  ortho({
    id: 'fi-mml',
    name: 'Maanmittauslaitos orthophotos (Finland)',
    license: 'CC BY 4.0',
    termsUrl: 'https://www.maanmittauslaitos.fi/en/opendata-licence-cc40',
    attribution: [
      {
        text: 'Contains data from the National Land Survey of Finland Orthophotos 10/2026',
        url: 'https://www.maanmittauslaitos.fi',
      },
    ],
    maxLevel: 18,
    regions: ['FI'],
    termsReadDate: SECOND_READING,
    keyParam: 'api-key',
    limits:
      'a free key of the application, registered with the National Land Survey; the open interface is not meant ' +
      'for high-volume services and has no availability guarantee',
    service: {
      kind: 'xyz',
      url: 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/ortokuva/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.jpg',
    },
  }),
  ortho({
    id: 'ee-maaamet',
    name: 'Maa- ja Ruumiamet orthophoto (Estonia)',
    license: 'Maa- ja Ruumiamet open data licence (commercial use and redistribution allowed, as CC BY 4.0)',
    termsUrl: 'https://geoportaal.maaamet.ee/avaandmete-litsents',
    attribution: [{ text: 'Ortofoto: Maa- ja Ruumiamet 2026', url: 'https://geoportaal.maaamet.ee' }],
    maxLevel: 19,
    regions: ['EE'],
    termsReadDate: SECOND_READING,
    service: { kind: 'wms', url: 'https://kaart.maaamet.ee/wms/alus-geo', layer: 'of10000' },
  }),
  ortho({
    id: 'pl-geoportal-orto',
    name: 'GUGiK Ortofotomapa (Poland)',
    license: 'free of charge, for any purpose (GUGiK)',
    termsUrl: 'https://www.geoportal.gov.pl/en/data/orthophotomap-orto/',
    attribution: [
      { text: 'Główny Urząd Geodezji i Kartografii (geoportal.gov.pl)', url: 'https://www.geoportal.gov.pl' },
    ],
    maxLevel: 19,
    regions: ['PL'],
    termsReadDate: SECOND_READING,
    limits: 'the Geoportal bars automated bulk downloading',
    service: {
      kind: 'xyz',
      url:
        'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution?SERVICE=WMTS&REQUEST=GetTile' +
        '&VERSION=1.0.0&LAYER=ORTOFOTOMAPA&STYLE=default&FORMAT=image/jpeg&tileMatrixSet=EPSG:3857' +
        '&tileMatrix=EPSG:3857:{z}&tileRow={y}&tileCol={x}',
    },
  }),
  ortho({
    id: 'hr-dgu-dof',
    name: 'DGU Digitalni ortofoto 2023–2024 (Croatia)',
    license: 'Otvorena dozvola, the open licence of the Republic of Croatia (NN 67/2017)',
    termsUrl: 'https://narodne-novine.nn.hr/clanci/sluzbeni/2017_07_67_1577.html',
    attribution: [
      { text: 'Izvor: Državna geodetska uprava, Digitalni ortofoto 2023.–2024.', url: 'https://geoportal.dgu.hr' },
    ],
    maxLevel: 19,
    regions: ['HR'],
    termsReadDate: SECOND_READING,
    service: {
      kind: 'wms',
      url: 'https://geoportal.dgu.hr/services/inspire/orthophoto_2023_2024/ows',
      layer: 'OI.OrthoimageCoverage',
    },
  }),
];
