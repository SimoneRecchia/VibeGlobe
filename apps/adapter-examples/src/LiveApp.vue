<script setup lang="ts">
// Reactive props changing the running engine in place (F474) and child components declaring data layers, markers and
// UI controls (F476), driven by the end-to-end specs through `window.adapterExample.live`.
import type { Globe } from '@vibeglobe/core';
import type { Feature } from '@vibeglobe/layers';
import { createOffline } from '@vibeglobe/offline';
import { xyzImagery } from '@vibeglobe/sources';
import { ScaleBarControl, ZoomControl } from '@vibeglobe/ui';
import {
  VibeControl,
  VibeDataLayer,
  VibeGlobe,
  VibeImageryLayer,
  VibeMarker,
  type GlobeExtras,
  type LayerLook,
  type NetworkMode,
  type QualityPresetChoice,
  type ToggleMode,
} from '@vibeglobe/vue';
import { nextTick, reactive, ref, shallowRef } from 'vue';
import CameraReadout from './CameraReadout.vue';
import { backend, BASE_IMAGERY_URL, fixtureTiles, type ExampleEvent } from './hooks.js';

const offline = createOffline({ store: 'memory' });
const imagery = [
  offline.source(xyzImagery({ id: 'world', url: fixtureTiles('world'), maxLevel: 18 })),
  offline.source(xyzImagery({ id: 'levels', url: fixtureTiles('levels'), maxLevel: 18, transparent: true })),
];
const view = reactive({ longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 5 });
const viewMode = ref<ToggleMode>('auto');
const layers = ref<LayerLook[]>([
  { id: 'world', visible: true, opacity: 1 },
  { id: 'levels', visible: true, opacity: 0.5 },
]);
const networkMode = ref<NetworkMode>('hybrid');
const qualityPreset = ref<QualityPresetChoice>();
const children = reactive({ points: false, marker: false, zoom: false, scale: false, overlay: false });
// A green overlay added at runtime on top of the globe's imagery (F476).
const overlaySource = xyzImagery({ id: 'overlay', url: fixtureTiles('green'), maxLevel: 18 });
const overlay = reactive({ opacity: 1, visible: true });
const points = ref<Feature[]>([]);
const marker = reactive({ longitudeDeg: 12.5, latitudeDeg: 41.9, color: '#1a73e8' });
const zoomControl = shallowRef(new ZoomControl());
const scaleControl = new ScaleBarControl();
const first = shallowRef<{ globe: Globe | undefined; extras: GlobeExtras }>();
const events: ExampleEvent[] = [];

const live = {
  offline,
  extras: (): GlobeExtras | undefined => first.value?.extras,
  async set(changes: {
    view?: Partial<typeof view>;
    viewMode?: ToggleMode;
    layers?: LayerLook[];
    networkMode?: NetworkMode;
    qualityPreset?: QualityPresetChoice;
    children?: Partial<typeof children>;
    points?: Feature[];
    marker?: Partial<typeof marker>;
    overlay?: Partial<typeof overlay>;
  }) {
    if (changes.view) Object.assign(view, changes.view);
    if (changes.viewMode) viewMode.value = changes.viewMode;
    if (changes.layers) layers.value = changes.layers;
    if (changes.networkMode) networkMode.value = changes.networkMode;
    if (changes.qualityPreset) qualityPreset.value = changes.qualityPreset;
    if (changes.children) Object.assign(children, changes.children);
    if (changes.points) points.value = changes.points;
    if (changes.marker) Object.assign(marker, changes.marker);
    if (changes.overlay) Object.assign(overlay, changes.overlay);
    await nextTick();
  },
  replaceZoomControl() {
    zoomControl.value = new ZoomControl({ position: 'top-left' });
  },
};
(window as unknown as { adapterExampleLive: typeof live }).adapterExampleLive = live;
window.adapterExample = {
  events,
  globes: () => [first.value?.globe],
  show: async () => undefined,
  async setView(next) {
    Object.assign(view, next);
    await nextTick();
  },
};
</script>

<template>
  <main>
    <VibeGlobe
      ref="first"
      :base-imagery-url="BASE_IMAGERY_URL"
      :imagery="imagery"
      :backend="backend"
      :longitude-deg="view.longitudeDeg"
      :latitude-deg="view.latitudeDeg"
      :zoom="view.zoom"
      :view-mode="viewMode"
      :layers="layers"
      :offline="offline"
      :network-mode="networkMode"
      :quality-preset="qualityPreset"
      @ready="events.push({ source: 'first', type: 'ready', payload: $event })"
    >
      <CameraReadout />
      <VibeDataLayer
        v-if="children.points"
        id="points"
        kind="point"
        :features="points"
        :style="{ 'circle-color': '#ff3030', 'circle-radius': 8 }"
      />
      <VibeMarker
        v-if="children.marker"
        :longitude-deg="marker.longitudeDeg"
        :latitude-deg="marker.latitudeDeg"
        :color="marker.color"
      />
      <VibeImageryLayer
        v-if="children.overlay"
        :source="overlaySource"
        :opacity="overlay.opacity"
        :visible="overlay.visible"
      />
      <VibeControl v-if="children.zoom" :control="zoomControl" />
      <VibeControl v-if="children.scale" :control="scaleControl" />
    </VibeGlobe>
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
</style>
