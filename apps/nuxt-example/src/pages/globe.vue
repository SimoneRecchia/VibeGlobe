<script setup lang="ts">
import type { Globe } from '@vibeglobe/core';
import { useCamera, useLoading, VibeGlobe } from '@vibeglobe/vue';
import { onBeforeUnmount, onMounted, shallowRef } from 'vue';

const globeComponent = shallowRef<{ globe: Globe | undefined }>();
const events: { source: string; type: string; payload: unknown }[] = [];
const record = (type: string) => (payload: unknown) => void events.push({ source: 'nuxt', type, payload });
const globe = shallowRef<Globe>();
const camera = useCamera(globe);
const loading = useLoading(globe);
const onReady = (payload: unknown): void => {
  globe.value = globeComponent.value?.globe;
  record('ready')(payload);
};
const backend = shallowRef<'auto' | 'webgpu' | 'webgl2'>('auto');

onMounted(() => {
  const forced = new URLSearchParams(location.search).get('backend');
  if (forced === 'webgpu' || forced === 'webgl2') backend.value = forced;
  // Test hooks (e2e/nuxt-example.spec.ts).
  (window as unknown as { adapterExample: unknown }).adapterExample = {
    events,
    globes: () => [globeComponent.value?.globe],
  };
});
onBeforeUnmount(() => {
  delete (window as unknown as { adapterExample?: unknown }).adapterExample;
});
</script>

<template>
  <main class="globe-page">
    <VibeGlobe
      ref="globeComponent"
      base-imagery-url="/imagery/natural-earth-4096.jpg"
      :backend="backend"
      :longitude-deg="12.5"
      :latitude-deg="41.9"
      :zoom="3"
      @ready="onReady"
      @load="record('load')"
      @globe-click="record('globe-click')"
    >
      <template #placeholder><p class="placeholder">Loading the globe…</p></template>
    </VibeGlobe>
    <p class="readout">
      {{ camera.longitudeDeg.toFixed(3) }}°, {{ camera.latitudeDeg.toFixed(3) }}° · zoom {{ camera.zoom.toFixed(2) }} ·
      {{ loading ? 'loading' : 'loaded' }}
    </p>
  </main>
</template>

<style>
.globe-page {
  position: relative;
  flex: 1;
}
.readout {
  position: absolute;
  left: 8px;
  bottom: 8px;
  margin: 0;
}
</style>
