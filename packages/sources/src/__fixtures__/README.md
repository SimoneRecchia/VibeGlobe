# Source adapter fixtures

Test fixtures of the source adapters; they are not shipped (`tsconfig.json` excludes this folder).

- `pmtiles-writer.ts`, `mbtiles-writer.ts`: write small PMTiles and MBTiles packages in memory for the conformance suites.
- `capabilities/`: recorded GetCapabilities documents of real and sample services, plus synthetic edge cases:
  - `wmts-ogc-sample.xml`, `wmts-arcgis.xml` (ArcGIS Online), `wmts-wgs84.xml`: from the OpenLayers test suite
    (https://github.com/openlayers/openlayers, BSD-2-Clause);
  - `wms-111-jpl.xml` (NASA JPL OnEarth), `wms-130-aasg.xml` (Arizona Geological Survey): from the OWSLib test suite
    (https://github.com/geopython/OWSLib, BSD-3-Clause);
  - `wmts-synthetic.xml`, `wms-synthetic-130.xml`: written for this repository.
