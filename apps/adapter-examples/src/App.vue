<script setup lang="ts">
import type { CameraState, Globe, GlobeError, GlobeEvents } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';
import { VibeGlobe, type GlobeClickEvent } from '@vibeglobe/vue';
import { nextTick, reactive, ref, shallowRef } from 'vue';
import CameraReadout from './CameraReadout.vue';
import { backend, BASE_IMAGERY_URL, fixtureTiles, params, type ExampleEvent } from './hooks.js';

// F479: `?two=1` shows two globes with different sources and cameras.
const two = params.has('two');
const imagery = params.has('imagery') ? [xyzImagery({ id: 'world', url: fixtureTiles('world'), maxLevel: 18 })] : [];
const secondImagery = [xyzImagery({ id: 'levels', url: fixtureTiles('levels'), maxLevel: 18 })];
const shown = ref(true);
const secondShown = ref(true);
const view = reactive({ longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 3 });
const first = shallowRef<{ globe: Globe | undefined }>();
const second = shallowRef<{ globe: Globe | undefined }>();
const events: ExampleEvent[] = [];
const readoutUpdates = ref(0);
const record = (source: string, type: string) => (payload: unknown) => void events.push({ source, type, payload });
const onCamera = (camera: CameraState): void =>
  void events.push({ source: 'first', type: 'camera-change', payload: { ...camera } });
const onClick = (click: GlobeClickEvent): void =>
  void events.push({ source: 'first', type: 'globe-click', payload: click });
const onReady = (ready: GlobeEvents['ready']): void =>
  void events.push({ source: 'first', type: 'ready', payload: ready });
const onError = (error: GlobeError): void => void events.push({ source: 'first', type: 'error', payload: error.code });

window.adapterExample = {
  events,
  globes: () => [first.value?.globe, ...(two ? [second.value?.globe] : [])],
  async show(on, index) {
    if (index !== 1) shown.value = on;
    if (index !== 0) secondShown.value = on;
    await nextTick();
  },
  async setView(next) {
    Object.assign(view, next);
    await nextTick();
  },
  displayed() {
    const readout = document.querySelector<HTMLElement>('.readout');
    return {
      longitudeDeg: Number(readout?.dataset['longitude']),
      latitudeDeg: Number(readout?.dataset['latitude']),
      zoom: Number(readout?.dataset['zoom']),
      loading: readout?.dataset['loading'] === 'true',
      updates: readoutUpdates.value,
    };
  },
};
</script>

<template>
  <main :class="{ two }">
    <section v-if="shown" class="globe">
      <VibeGlobe
        ref="first"
        :base-imagery-url="BASE_IMAGERY_URL"
        :imagery="imagery"
        :backend="backend"
        :longitude-deg="view.longitudeDeg"
        :latitude-deg="view.latitudeDeg"
        :zoom="view.zoom"
        @ready="onReady"
        @load="record('first', 'load')($event)"
        @camera-change="onCamera"
        @globe-click="onClick"
        @error="onError"
      >
        <template #placeholder><p class="placeholder">Loading the globe…</p></template>
        <CameraReadout @updated="readoutUpdates++" />
      </VibeGlobe>
    </section>
    <section v-if="two && secondShown" class="globe">
      <VibeGlobe
        ref="second"
        :base-imagery-url="BASE_IMAGERY_URL"
        :imagery="secondImagery"
        :backend="backend"
        :longitude-deg="-74"
        :latitude-deg="40.7"
        :zoom="4"
        @ready="record('second', 'ready')($event)"
      />
    </section>
    <!-- vue-tsc must reject a wrongly typed prop (F473): this never renders, and the build fails if it type-checks. -->
    <!-- @vue-expect-error zoom is a number -->
    <VibeGlobe v-if="false" :base-imagery-url="BASE_IMAGERY_URL" zoom="far" />
  </main>
</template>

<style>
html,
body,
#app,
main {
  height: 100%;
  margin: 0;
  background: #0b1020;
}
main.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.globe {
  position: relative;
  height: 100%;
}
.placeholder {
  color: #ccc;
  font:
    14px system-ui,
    sans-serif;
  text-align: center;
}
</style>
