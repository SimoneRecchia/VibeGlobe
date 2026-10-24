<script setup lang="ts">
// One page per feature group of PLAN.md (F488): a globe with the generated source and the components the group uses;
// its browser checks are exposed on `window.featureChecks` for e2e/nuxt-features.spec.ts.
import type { Globe, ImagerySource } from '@vibeglobe/core';
import type { Feature } from '@vibeglobe/layers';
import type { UiControl } from '@vibeglobe/ui';
import {
  VibeControl,
  VibeDataLayer,
  VibeGlobe,
  VibeMarker,
  type GlobeExtras,
  type NetworkModeTarget,
} from '@vibeglobe/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef } from 'vue';
import { FEATURE_GROUPS } from '../../utils/feature-groups';

const route = useRoute();
const group = computed(() => FEATURE_GROUPS.find((candidate) => candidate.id === route.params['group']));
const globeComponent = shallowRef<{ globe: Globe | undefined; extras: GlobeExtras }>();
const imagery = shallowRef<ImagerySource[]>();
const offline = shallowRef<
  NetworkModeTarget & { stats(id?: string): { network: number; package: number }; installArea(): Promise<number> }
>();
const controls = shallowRef<UiControl[]>([]);
const backend = shallowRef<'auto' | 'webgpu' | 'webgl2'>('auto');
const points: Feature[] = [
  { type: 'Feature', id: 'rome', geometry: { type: 'Point', coordinates: [12.5, 41.9] }, properties: {} },
  { type: 'Feature', id: 'milan', geometry: { type: 'Point', coordinates: [9.19, 45.46] }, properties: {} },
];

// The page's own setup (sources, controls) can finish after the globe is ready: the checks wait for it (F488).
let setUp: () => void = () => undefined;
const pageSetUp = new Promise<void>((resolve) => (setUp = resolve));

onMounted(async () => {
  const forced = new URLSearchParams(location.search).get('backend');
  if (forced === 'webgpu' || forced === 'webgl2') backend.value = forced;
  const { generatedFetch, generatedImagery } = await import('../../utils/generated-source');
  const source = generatedImagery();
  if (group.value?.id === 'offline') {
    const { createOffline, createPackageManager } = await import('@vibeglobe/offline');
    const engine = createOffline({ store: 'memory', fetch: generatedFetch });
    // An offline package downloaded in the browser: the area around Tokyo to level 5.
    const packages = createPackageManager(engine, { fetch: generatedFetch });
    const installArea = async (): Promise<number> => {
      await packages.ready;
      const installed = await packages.install({
        id: 'tokyo',
        version: '1',
        area: { westDeg: 138.7, southDeg: 35, eastDeg: 140.7, northDeg: 36.4 },
        minLevel: 0,
        maxLevel: 5,
        sources: [{ source, license: 'CC0-1.0', attribution: { text: 'Generated tiles' } }],
      });
      return installed.report?.tiles ?? 0;
    };
    offline.value = Object.assign(engine, { installArea });
    imagery.value = [engine.source(source)];
  } else imagery.value = [source];
  const ui = await import('@vibeglobe/ui');
  if (group.value?.id === 'navigation' || group.value?.id === 'security') controls.value = [new ui.ZoomControl()];
  if (group.value?.id === 'ui')
    controls.value = [new ui.ZoomControl(), new ui.CompassControl(), new ui.ScaleBarControl()];
  setUp();
});

async function onReady(): Promise<void> {
  const globe = globeComponent.value?.globe;
  const extras = globeComponent.value?.extras;
  if (globe === undefined || extras === undefined || group.value === undefined) return;
  // The controls set up last are mounted by the next tick and added once the globe's UI has loaded: awaiting the same
  // load after them, the checks see them added.
  await pageSetUp;
  await nextTick();
  if (controls.value.length > 0) await extras.ui();
  const { checksFor } = await import('../../utils/feature-checks');
  const checks = checksFor(group.value.id, { globe, extras, ...(offline.value ? { offline: offline.value } : {}) });
  (window as unknown as { featureChecks: unknown }).featureChecks = {
    names: Object.keys(checks),
    async run() {
      const results: Record<string, boolean> = {};
      for (const [name, check] of Object.entries(checks)) results[name] = await check().catch(() => false);
      return results;
    },
  };
  (window as unknown as { adapterExample: unknown }).adapterExample = { events: [], globes: () => [globe] };
}

onBeforeUnmount(() => {
  delete (window as unknown as { featureChecks?: unknown }).featureChecks;
  delete (window as unknown as { adapterExample?: unknown }).adapterExample;
});
</script>

<template>
  <main class="feature-page">
    <header>
      <h1>{{ group?.title ?? 'Unknown feature group' }}</h1>
      <p>{{ group?.summary }}</p>
    </header>
    <section class="feature-globe">
      <VibeGlobe
        v-if="imagery"
        ref="globeComponent"
        base-imagery-url="/imagery/natural-earth-4096.jpg"
        :imagery="imagery"
        :backend="backend"
        :offline="offline"
        :longitude-deg="12.5"
        :latitude-deg="41.9"
        :zoom="5"
        @ready="onReady"
      >
        <template v-if="group?.id === 'data-layers'">
          <VibeDataLayer
            id="cities"
            kind="point"
            :features="points"
            :style="{ 'circle-color': '#ff3030', 'circle-radius': 7 }"
          />
          <VibeMarker :longitude-deg="11.25" :latitude-deg="43.77" />
        </template>
        <VibeControl v-for="control in controls" :key="control.id" :control="control" />
      </VibeGlobe>
    </section>
  </main>
</template>

<style>
.feature-page {
  display: flex;
  flex-direction: column;
  flex: 1;
}
.feature-page header {
  padding: 0 8px;
}
.feature-page h1 {
  font-size: 18px;
  margin: 4px 0;
}
.feature-page p {
  margin: 0 0 8px;
}
.feature-globe {
  position: relative;
  flex: 1;
}
</style>
