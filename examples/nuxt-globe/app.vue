<script setup lang="ts">
import type { Globe, ImagerySource } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';
import { VibeGlobe } from '@vibeglobe/vue';
import { onMounted, shallowRef } from 'vue';

const component = shallowRef<{ globe: Globe | undefined }>();
const imagery = shallowRef<ImagerySource[]>();
const backend = shallowRef<'auto' | 'webgpu' | 'webgl2'>('auto');

onMounted(() => {
  const forced = new URLSearchParams(location.search).get('backend');
  if (forced === 'webgpu' || forced === 'webgl2') backend.value = forced;
  // KTX2 tiles, so the worker program's WebAssembly transcoder runs.
  imagery.value = [
    xyzImagery({
      id: 'imagery',
      url: `${location.origin}/fixture-tiles/release/world/mercator/{z}/{x}/{y}.etc1s.ktx2`,
      decoder: 'ktx2',
      maxLevel: 6,
    }),
  ];
});
// The release checks read the globe (scripts/release/check-consumers.ts).
const onReady = (): void => {
  (window as unknown as { minimalGlobe?: Globe }).minimalGlobe = component.value?.globe;
};
</script>

<template>
  <main style="width: 100vw; height: 100vh; margin: 0">
    <VibeGlobe
      v-if="imagery"
      ref="component"
      base-imagery-url="/natural-earth-4096.jpg"
      :imagery="imagery"
      :backend="backend"
      :longitude-deg="12.5"
      :latitude-deg="42"
      :zoom="4"
      @ready="onReady"
    />
  </main>
</template>
