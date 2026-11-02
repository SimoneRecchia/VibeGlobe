// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it } from 'vitest';
import * as gis from './index.js';

describe('@vibeglobe/gis', () => {
  it('exports generic GIS functions and nothing of one application domain, such as solar tables (F692)', () => {
    expect(Object.keys(gis).sort()).toEqual(
      expect.arrayContaining(['formatCoordinate', 'gridLines', 'measureDistance', 'parseCoordinate', 'toUtm']),
    );
    for (const name of Object.keys(gis)) expect(name).not.toMatch(/panel|solar|turbine|inverter/i);
  });
});
