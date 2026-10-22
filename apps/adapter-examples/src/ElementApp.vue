<script setup lang="ts">
import { defineVibeGlobe } from '@vibeglobe/web-component';
import { nextTick, ref } from 'vue';
import { elementHooks } from './element-hooks.js';
import { backend, BASE_IMAGERY_URL, type ExampleEvent } from './hooks.js';

// F483: the element inside a Vue app (vite.config.ts tells Vue's compiler that `vibe-globe` is a custom element).
defineVibeGlobe();
const events: ExampleEvent[] = [];
const shown = ref(true);
const record = (type: string) => (event: Event) =>
  void events.push({ source: 'vue', type, payload: (event as CustomEvent).detail });
window.adapterExample = elementHooks(events, async (on) => {
  shown.value = on;
  await nextTick();
});
</script>

<template>
  <vibe-globe
    v-if="shown"
    :base-imagery-url="BASE_IMAGERY_URL"
    :backend="backend"
    center="12.5, 41.9"
    zoom="3"
    style="display: block; height: 100%"
    @ready="record('ready')($event)"
    @load="record('load')($event)"
    @camera-change="record('camera-change')($event)"
    @globe-click="record('globe-click')($event)"
  />
</template>
