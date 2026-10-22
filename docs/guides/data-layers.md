# Data layers guide

This guide grows with the data layers (M10) and vector tiles (M13). It currently documents building extrusion.

## Buildings

Vector-tile buildings are extruded by `@vibeglobe/layers/vector-tiles` (`buildingHeight`, `extrudeBuilding`,
ADR 0034). The height of a building comes from its tags, in this order:

1. `height` (or OpenMapTiles' `render_height`), in meters; `ft` and `'` suffixes are converted.
2. `building:levels` × 3 m.
3. The default for its `building` (or `building:part`) type, below.

The base comes from `min_height` (or `render_min_height`), else `building:min_level` × 3 m, else the ground. An
outline that contains `building:part` features, or carries `hide_3d`, is not extruded: its parts replace it. Heights
depend only on a building's tags, so a building has the same height in every tile and after every reload. On the flat
map, heights scale with the Web Mercator scale factor `1 / cos(latitude)`; measurements stay in meters.

| `building`                                                            | Default height (m) |
| --------------------------------------------------------------------- | -----------------: |
| `house`, `detached`, `semidetached_house`, `retail`, `farm`           |                  6 |
| `terrace`                                                             |                  9 |
| `residential`, `commercial`, `public`, `civic`, `temple`              |                 12 |
| `apartments`, `mosque`, `university`, `train_station`                 |                 15 |
| `office`, `hotel`, `hospital`                                         |                 18 |
| `industrial`, `warehouse`, `chapel`, `barn`, `yes` and any other type |                  8 |
| `school`                                                              |                 10 |
| `church`                                                              |                 20 |
| `cathedral`                                                           |                 35 |
| `roof`, `greenhouse`                                                  |                  4 |
| `garage`, `garages`, `carport`, `shed`, `hut`                         |                  3 |
