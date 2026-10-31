import { describe, expect, it } from 'vitest';
import { measureShape } from '../controls/measure.js';
import { DrawingTool, type DrawEvents } from './drawing-tool.js';
import { groundScreen, ringSelfIntersects, type LonLat } from './geometry.js';

/** A tool and the events it emitted, by name. */
function recorded(): { tool: DrawingTool; events: string[] } {
  const tool = new DrawingTool();
  const events: string[] = [];
  for (const name of ['create', 'change', 'delete', 'validation'] as const)
    tool.on(name, (payload: DrawEvents[typeof name]) =>
      events.push(
        `${name}:${'feature' in payload ? payload.feature.geometry.type : 'reason' in payload ? payload.reason : payload.id}`,
      ),
    );
  return { tool, events };
}

describe('the drawing tool (F407–F410)', () => {
  it('loads a saved shape without a create event, refusing one that crosses itself (F660)', () => {
    const { tool, events } = recorded();
    const id = tool.addShape('polygon', [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    expect(id).toBeDefined();
    expect(tool.shape(id ?? '')?.coordinates).toHaveLength(4);
    expect(
      tool.addShape('polygon', [
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
      ]),
    ).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('draws points, lines and polygons, finishing on a repeated last vertex', () => {
    const { tool, events } = recorded();
    tool.setMode('point');
    tool.place([7, 45]);
    tool.place([8, 46]);
    tool.setMode('line');
    tool.place([0, 0]);
    tool.place([1, 1]);
    tool.place([1, 1]);
    expect(tool.finish()).toBe(true);
    tool.setMode('polygon');
    for (const p of [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 0],
    ] as LonLat[])
      tool.place(p);
    expect(tool.finish()).toBe(true);
    expect(events).toEqual(['create:Point', 'create:Point', 'create:LineString', 'create:Polygon']);
    const polygon = tool.features().at(-1);
    expect(polygon?.geometry.coordinates).toEqual([
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 0],
      ],
    ]);
  });

  it('reports a self-intersecting polygon and does not finish or apply it', () => {
    const { tool, events } = recorded();
    tool.setMode('polygon');
    for (const p of [
      [0, 0],
      [2, 2],
      [2, 0],
      [0, 2],
    ] as LonLat[])
      tool.place(p);
    expect(tool.finish()).toBe(false);
    expect(events).toEqual(['validation:self-intersection']);
    tool.cancel();
    for (const p of [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ] as LonLat[])
      tool.place(p);
    tool.finish();
    const id = tool.features()[0]?.id ?? '';
    expect(tool.moveVertex(id, 2, [-1, 1])).toBe(false);
    expect(events.at(-1)).toBe('validation:self-intersection');
    expect(tool.shape(id)?.coordinates[2]).toEqual([2, 2]);
  });

  it('edits: moves, inserts and deletes vertices, moves and deletes shapes, with change events', () => {
    const { tool, events } = recorded();
    tool.setMode('line');
    for (const p of [
      [0, 0],
      [2, 0],
      [2, 2],
    ] as LonLat[])
      tool.place(p);
    tool.finish();
    const id = tool.features()[0]?.id ?? '';
    tool.setMode('edit');
    tool.select(id);
    expect(tool.handles().map((h) => `${h.kind}${h.index}`)).toEqual([
      'vertex0',
      'vertex1',
      'vertex2',
      'midpoint0',
      'midpoint1',
    ]);
    expect(tool.moveVertex(id, 2, [3, 3])).toBe(true);
    expect(tool.insertVertex(id, 0, [1, 0])).toBe(true);
    expect(tool.selection).toEqual({ shapeId: id, vertex: 1 });
    expect(tool.deleteSelection()).toBe(true);
    expect(tool.moveShape(id, 10, 1)).toBe(true);
    expect(tool.shape(id)?.coordinates).toEqual([
      [10, 1],
      [12, 1],
      [13, 4],
    ]);
    expect(tool.deleteVertex(id, 0)).toBe(true);
    // A line keeps two vertices.
    expect(tool.deleteVertex(id, 0)).toBe(false);
    tool.select(id);
    expect(tool.deleteSelection()).toBe(true);
    expect(events.slice(1)).toEqual([
      'change:LineString',
      'change:LineString',
      'change:LineString',
      'change:LineString',
      'change:LineString',
      `delete:${id}`,
    ]);
  });

  it('judges rings across the antimeridian as drawn', () => {
    expect(
      ringSelfIntersects([
        [179, 0],
        [-179, 0],
        [-179, 2],
        [179, 2],
      ]),
    ).toBe(false);
    expect(
      ringSelfIntersects([
        [179, 0],
        [-179, 2],
        [-179, 0],
        [179, 2],
      ]),
    ).toBe(true);
  });
});

describe('measurement (F411)', () => {
  it('measures a path with the bearing of its last segment, and a polygon’s area and perimeter', () => {
    const line = measureShape('line', [
      [0, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(line.lengthMeters).toBeCloseTo(110_574.4 + 111_302.6, -1);
    expect(line.bearingDeg).toBeCloseTo(90, 1);
    const square = measureShape('polygon', [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    expect(square.areaSquareMeters / 1e6).toBeCloseTo(12_308.8, 0);
    expect(square.bearingDeg).toBeUndefined();
  });
});

describe('drawn positions on screen (KB-289)', () => {
  /** A projection that shows height as a shift up the screen, over ground 30 m high. */
  const globe = (relief: number, readable = true) => ({
    camera: { reliefFactor: relief },
    elevationAt: () => {
      if (!readable) throw new Error('display only');
      return { heightMeters: 30 };
    },
    geoToScreen: (p: { longitudeDeg: number; latitudeDeg: number; heightMeters?: number }) => ({
      xPx: p.longitudeDeg * 100,
      yPx: p.latitudeDeg * 100 - (p.heightMeters ?? 0),
    }),
  });

  it('finds a vertex where the ground shows it, its height times the relief, not on the ellipsoid', () => {
    expect(groundScreen(globe(1), [1, 2])).toEqual({ xPx: 100, yPx: 170 });
    expect(groundScreen(globe(0.5), [1, 2])).toEqual({ xPx: 100, yPx: 185 });
    expect(groundScreen(globe(0), [1, 2])).toEqual({ xPx: 100, yPx: 200 });
    expect(groundScreen(globe(1, false), [1, 2])).toEqual({ xPx: 100, yPx: 200 });
  });
});
