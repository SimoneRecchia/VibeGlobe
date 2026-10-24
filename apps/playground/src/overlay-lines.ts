import type { Globe, ImageryStats } from '@vibeglobe/core';

/** The debug overlay's surface row: drawn tiles and what culling skipped (F086, F087). */
export function surfaceLine(globe: Globe): string {
  const selection = globe.surfaceStats();
  return (
    `tiles ${selection.tiles} · level ≤ ${selection.maxLevel} · culled: frustum ${selection.culledByFrustum}, ` +
    `horizon ${selection.culledByHorizon} · imagery from ancestor ${selection.fromAncestor}, base ${selection.onBaseImage}` +
    // The largest projected texel of any drawn tile, which the selection keeps at or below 1.5 px (F081).
    ` · texel ≤ ${Math.max(0, ...globe.surfaceTiles().map((tile) => tile.texelErrorPx)).toFixed(2)} px`
  );
}

/** The debug overlay's cache row: RAM hits (F097) and memory against the budgets (F098). */
export function cacheLine(imagery: ImageryStats): string {
  const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);
  return (
    `RAM hits ${imagery.ramHits} · misses ${imagery.ramMisses} · requests in flight ${imagery.loading} · ` +
    `GPU ${mb(imagery.gpuBytes)}/${mb(imagery.gpuBudgetBytes)} MB · RAM ` +
    `${mb(imagery.ramBytes)}/${mb(imagery.ramBudgetBytes)} MB · evicted ${imagery.evicted} · bandwidth ` +
    `${(imagery.bandwidthBitsPerSecond / 1e6).toFixed(2)} Mbps · latency ${imagery.latencyMs.toFixed(0)} ms`
  );
}
