// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * 3D Tiles traversal (F461, F462; ADR 0041): selects the tiles to draw by screen-space error and the requests to make,
 * once per frame. A tile refines when its screen-space error, `geometricError × viewportHeight / (2 × distance ×
 * tan(fovY / 2))`, exceeds the maximum. REPLACE keeps the parent drawn until every visible child that replaces it is
 * covered (its content ready, or itself replaced by covered children), so no hole ever appears, also on a slow network
 * or when a child fails. ADD draws the parent and its children. External tilesets and empty tiles always refine.
 * Requests carry a priority (lower first: large errors near the screen center first) for the engine scheduler.
 */
import { expandImplicitChildren, needsSubtree } from './implicit.js';
import type { Tile3D } from './tileset.js';
import { boundingRadius, distanceToVolume, intersectsFrustum, type Plane, type WorldVolume } from './volumes.js';

/** The camera as traversal needs it, in ECEF meters. */
export interface TraversalCamera {
  readonly position: readonly [number, number, number];
  /** Unit view direction, for priorities (screen-center tiles first). */
  readonly direction: readonly [number, number, number];
  /** Frustum planes; tiles outside are culled. Omit to disable culling. */
  readonly planes?: readonly Plane[];
  readonly viewportHeightPx: number;
  readonly fovYRad: number;
}

/** Traversal options. */
export interface TraversalOptions {
  /** Refine while a tile's screen-space error is above this, in pixels (CesiumJS and 3DTilesRendererJS use 16). */
  readonly maximumScreenSpaceError: number;
}

/** A request traversal wants made. */
export interface TileRequest {
  readonly tile: Tile3D;
  /** `content`: the tile's content; `subtree`: the implicit subtree rooted at the tile. */
  readonly kind: 'content' | 'subtree';
  /** Lower is more urgent. */
  readonly priority: number;
}

/** The result of one traversal. */
export interface TraversalResult {
  /** Tiles to draw this frame, each with ready content. */
  readonly render: Tile3D[];
  readonly requests: TileRequest[];
  /** Every tile the view needs this frame (drawn, requested, or kept as a stand-in): the cache must not evict them. */
  readonly used: Set<Tile3D>;
  /** Each visited tile's screen-space error, for the debug overlay. */
  readonly screenSpaceError: Map<Tile3D, number>;
}

/** The screen-space error of a geometric error at a distance. */
export function screenSpaceError(geometricError: number, distanceMeters: number, camera: TraversalCamera): number {
  if (distanceMeters <= 0) return Infinity;
  return (geometricError * camera.viewportHeightPx) / (2 * distanceMeters * Math.tan(camera.fovYRad / 2));
}

function priority(volume: WorldVolume, sse: number, camera: TraversalCamera): number {
  const toTile = volume.center.map((c, i) => c - (camera.position[i] ?? 0));
  const distance = Math.hypot(...toTile);
  const radius = boundingRadius(volume);
  const cos = distance > 0 ? toTile.reduce((s, c, i) => s + c * (camera.direction[i] ?? 0), 0) / distance : 1;
  // Angle from the screen center, reduced by the tile's own angular size; 0 when the center ray crosses the tile.
  const angle = Math.max(0, Math.acos(Math.max(-1, Math.min(1, cos))) - Math.atan2(radius, Math.max(distance, 1e-6)));
  return (1 + angle) / (1 + Math.min(sse, 1e9));
}

interface Visit {
  readonly render: Tile3D[];
  /** Whether the tile's area is fully drawn by the render list (the parent may be replaced). */
  readonly covered: boolean;
}

class Traversal {
  readonly result: TraversalResult = { render: [], requests: [], used: new Set(), screenSpaceError: new Map() };

  constructor(
    private readonly camera: TraversalCamera,
    private readonly options: TraversalOptions,
  ) {}

  private request(tile: Tile3D, kind: TileRequest['kind'], sse: number): void {
    this.result.requests.push({ tile, kind, priority: priority(tile.volume, sse, this.camera) });
  }

  private visible(tile: Tile3D): boolean {
    const planes = this.camera.planes;
    if (planes !== undefined && !intersectsFrustum(tile.volume, planes)) return false;
    const viewer = tile.viewerRequestVolume;
    return viewer === undefined || distanceToVolume(viewer, this.camera.position) === 0;
  }

  visit(tile: Tile3D): Visit {
    if (!this.visible(tile)) return { render: [], covered: true };
    const sse = screenSpaceError(tile.geometricError, distanceToVolume(tile.volume, this.camera.position), this.camera);
    this.result.screenSpaceError.set(tile, sse);
    this.result.used.add(tile);
    if (needsSubtree(tile)) {
      if (tile.state === 'unloaded') this.request(tile, 'subtree', sse);
      return { render: [], covered: false };
    }
    expandImplicitChildren(tile);
    const contents = tile.contents.length > 0;
    const external = contents && tile.contents.every((c) => c.external);
    if (contents && tile.state === 'unloaded') this.request(tile, 'content', sse);
    const ready = !contents || tile.state === 'ready';
    const drawable = contents && !external && tile.state === 'ready';
    const own: Tile3D[] = drawable ? [tile] : [];
    const mustRefine = (!contents || external) && tile.children.length > 0;
    if (tile.children.length === 0 || (!mustRefine && sse <= this.options.maximumScreenSpaceError)) {
      return { render: own, covered: ready };
    }
    if (external && !ready) return { render: [], covered: false };
    const children = tile.children.map((child) => this.visit(child));
    const childRender = children.flatMap((c) => c.render);
    if (tile.refine === 'ADD') {
      return { render: [...own, ...childRender], covered: ready && children.every((c) => c.covered) };
    }
    if (children.every((c) => c.covered)) return { render: childRender, covered: true };
    // Not every child is ready: keep this tile in their place (or, without content, what the ready children draw).
    return drawable ? { render: own, covered: true } : { render: childRender, covered: false };
  }
}

/**
 * Selects the tiles to draw and the requests to make for this frame. Tiles whose content failed stay unready, so the
 * parent they would replace stays drawn.
 */
export function selectTiles(root: Tile3D, camera: TraversalCamera, options: TraversalOptions): TraversalResult {
  const traversal = new Traversal(camera, options);
  const { render } = traversal.visit(root);
  traversal.result.render.push(...render);
  traversal.result.requests.sort((a, b) => a.priority - b.priority);
  return traversal.result;
}

/** The in-flight requests this frame no longer wants: cancel them (during flights most of them are). */
export function requestsToCancel(inFlight: Iterable<Tile3D>, result: TraversalResult): Tile3D[] {
  const wanted = new Set(result.requests.map((r) => r.tile));
  return [...inFlight].filter((tile) => !wanted.has(tile) && !result.used.has(tile));
}
