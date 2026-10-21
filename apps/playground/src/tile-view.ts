import type { Globe, SurfaceTileInfo } from '@vibeglobe/core';

/**
 * The debug overlay's tile view (F116): every drawn surface tile outlined, labeled with its level, its geometric
 * screen-space error and the source of its imagery; tiles drawn from an ancestor's imagery are outlined in orange and
 * dashed. A separate layer over the globe, so turning it off leaves the globe's frames untouched.
 */

const SVG = 'http://www.w3.org/2000/svg';
const EDGE_SAMPLES = 8;
const REFRESH_MS = 250;

/** The tile's outline on screen, as an SVG path; empty when no part of it projects. */
function outline(globe: Globe, tile: SurfaceTileInfo): string {
  const { westDeg: west, southDeg: south, eastDeg: east, northDeg: north } = tile;
  const points: string[] = [];
  const corners: [number, number][] = [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
  for (let side = 0; side < 4; side++) {
    const [lon0, lat0] = corners[side] ?? [0, 0];
    const [lon1, lat1] = corners[(side + 1) % 4] ?? [0, 0];
    for (let i = 0; i < EDGE_SAMPLES; i++) {
      const t = i / EDGE_SAMPLES;
      const point = globe.geoToScreen({
        longitudeDeg: lon0 + (lon1 - lon0) * t,
        latitudeDeg: lat0 + (lat1 - lat0) * t,
      });
      if (point) points.push(`${point.xPx.toFixed(1)},${point.yPx.toFixed(1)}`);
    }
  }
  return points.length > 1 ? `M${points.join('L')}Z` : '';
}

/** Shows the tile view over `host` while `enabled`; returns a function that turns it on or off. */
function createTileView(globe: Globe, host: HTMLElement, sourceId: string | undefined): (on: boolean) => void {
  let layer: HTMLDivElement | undefined;
  let timer: number | undefined;
  const draw = (): void => {
    if (!layer) return;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    const labels: HTMLElement[] = [];
    for (const tile of globe.surfaceTiles()) {
      const ancestor = tile.imageryLevel !== null && tile.imageryLevel < tile.level;
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', outline(globe, tile));
      path.setAttribute('class', ancestor ? 'ancestor' : '');
      svg.append(path);
      const center = globe.geoToScreen({
        longitudeDeg: (tile.westDeg + tile.eastDeg) / 2,
        latitudeDeg: (tile.southDeg + tile.northDeg) / 2,
      });
      const label = document.createElement('span');
      label.dataset['tile'] = `${tile.root}/${tile.level}/${tile.x}/${tile.y}`;
      label.className = ancestor ? 'ancestor' : '';
      const source = tile.imageryLevel === null ? 'base' : `${sourceId ?? 'imagery'} L${tile.imageryLevel}`;
      label.textContent = `L${tile.level} · SSE ${tile.geometricErrorPx.toFixed(1)} · ${source}`;
      label.style.transform = `translate(${center?.xPx ?? -1000}px, ${center?.yPx ?? -1000}px)`;
      labels.push(label);
    }
    layer.replaceChildren(svg, ...labels);
  };
  return (on) => {
    if (on && !layer) {
      layer = document.createElement('div');
      layer.className = 'tile-view';
      host.append(layer);
      draw();
      timer = window.setInterval(draw, REFRESH_MS);
    } else if (!on && layer) {
      window.clearInterval(timer);
      layer.remove();
      layer = undefined;
    }
  };
}

/** Adds the "Tile view" checkbox that turns the tile view on and off (F116). */
export function addTileViewToggle(globe: Globe, host: HTMLElement, sourceId: string | undefined): void {
  const tileView = createTileView(globe, host, sourceId);
  const toggle = document.createElement('label');
  toggle.className = 'tile-view-toggle';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.addEventListener('change', () => tileView(checkbox.checked));
  toggle.append(checkbox, ' Tile view');
  host.append(toggle);
}
