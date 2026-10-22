<script setup lang="ts">
import { useCamera, useLoading, useViewMode } from '@vibeglobe/vue';
import { onBeforeUpdate } from 'vue';

// Rendered inside the globe's default slot: the composables find the engine through injection.
const camera = useCamera();
const loading = useLoading();
const viewMode = useViewMode();
const emit = defineEmits<{ updated: [] }>();
onBeforeUpdate(() => emit('updated'));
</script>

<template>
  <output
    class="readout"
    :data-longitude="camera.longitudeDeg"
    :data-latitude="camera.latitudeDeg"
    :data-zoom="camera.zoom"
    :data-loading="loading"
    :data-view-mode="viewMode"
  >
    {{ camera.longitudeDeg.toFixed(4) }}°, {{ camera.latitudeDeg.toFixed(4) }}° · zoom {{ camera.zoom.toFixed(2) }} ·
    {{ viewMode }} · {{ loading ? 'loading' : 'loaded' }}
  </output>
</template>

<style scoped>
.readout {
  position: absolute;
  left: 8px;
  bottom: 8px;
  padding: 2px 6px;
  font:
    12px system-ui,
    sans-serif;
  color: #fff;
  background: rgb(0 0 0 / 60%);
}
</style>
