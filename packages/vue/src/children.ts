import type { DataLayer, Feature, LayerStyle } from '@vibeglobe/layers';
import type { UiControl } from '@vibeglobe/ui';
import { defineComponent, inject, onBeforeUnmount, onMounted, watch, type PropType } from 'vue';
import { EXTRAS_KEY, type GlobeExtras } from './context.js';

/** The kinds of data layer a {@link VibeDataLayer} draws. */
export type DataLayerKind = 'point' | 'marker' | 'label' | 'polyline' | 'polygon' | 'circle';

function extrasOf(name: string): GlobeExtras {
  const extras = inject(EXTRAS_KEY, undefined);
  if (extras === undefined) throw new Error(`<${name}> must be rendered inside <VibeGlobe>`);
  return extras;
}

/** Runs `use` with the globe's extras once mounted, and its cleanup when unmounted (even if it resolves later). */
function onAttached(name: string, use: (extras: GlobeExtras) => Promise<(() => void) | undefined>): void {
  const extras = extrasOf(name);
  let cleanup: (() => void) | undefined;
  let unmounted = false;
  onMounted(() => {
    void use(extras)
      .then((stop) => {
        if (unmounted) stop?.();
        else cleanup = stop;
      })
      .catch(() => undefined);
  });
  onBeforeUnmount(() => {
    unmounted = true;
    cleanup?.();
  });
}

/**
 * A data layer of the enclosing globe (`@vibeglobe/layers`): points, markers, labels, lines, polygons or circles from
 * GeoJSON features, styled with MapLibre properties. Changing `features`, `style` or `visible` updates the layer in
 * place; unmounting removes it and frees its GPU buffers.
 */
export const VibeDataLayer = defineComponent({
  name: 'VibeDataLayer',
  props: {
    /** Unique among the globe's data layers. */
    id: { type: String, required: true },
    kind: { type: String as PropType<DataLayerKind>, required: true },
    features: { type: Array as PropType<readonly Feature[]>, default: () => [] },
    style: { type: Object as PropType<LayerStyle>, default: undefined },
    visible: { type: Boolean, default: true },
  },
  setup(props) {
    onAttached('VibeDataLayer', async (extras) => {
      const [{ stack }, module] = await Promise.all([extras.layers(), import('@vibeglobe/layers')]);
      const factories = {
        point: module.pointLayer,
        marker: module.markerLayer,
        label: module.labelLayer,
        polyline: module.polylineLayer,
        polygon: module.polygonLayer,
        circle: module.circleLayer,
      } as const;
      const layer: DataLayer = stack.add(
        factories[props.kind]({ id: props.id, ...(props.style ? { style: props.style } : {}) }),
      );
      let shown: (string | number)[] = [];
      const show = (features: readonly Feature[]): void => {
        for (const id of shown) layer.removeFeature(id);
        layer.addFeatures(features);
        shown = features.map((feature, index) => feature.id ?? index);
      };
      show(props.features);
      stack.setVisible(props.id, props.visible);
      const stops = [
        watch(() => props.features, show),
        watch(
          () => props.style,
          (style) => style && layer.setStyle(style),
        ),
        watch(
          () => props.visible,
          (visible) => stack.setVisible(props.id, visible),
        ),
      ];
      return () => {
        for (const stop of stops) stop();
        stack.remove(layer);
      };
    });
    return () => null;
  },
});

let markers = 0;

/** A marker: one point at a position, drawn on the ground; moving it updates the point in place. */
export const VibeMarker = defineComponent({
  name: 'VibeMarker',
  props: {
    longitudeDeg: { type: Number, required: true },
    latitudeDeg: { type: Number, required: true },
    color: { type: String, default: '#1a73e8' },
    /** Radius in CSS pixels. */
    sizePx: { type: Number, default: 7 },
  },
  setup(props) {
    const id = `vue-marker-${++markers}`;
    onAttached('VibeMarker', async (extras) => {
      const [{ stack }, { pointLayer }] = await Promise.all([extras.layers(), import('@vibeglobe/layers')]);
      const style = (): LayerStyle => ({
        'circle-color': props.color,
        'circle-radius': props.sizePx,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      });
      const layer = stack.add(pointLayer({ id, style: style() }));
      layer.addFeatures([
        {
          type: 'Feature',
          id,
          geometry: { type: 'Point', coordinates: [props.longitudeDeg, props.latitudeDeg] },
          properties: {},
        },
      ]);
      const stops = [
        watch(
          () => [props.longitudeDeg, props.latitudeDeg] as const,
          ([lon, lat]) => layer.setFeaturePosition(id, lon, lat),
        ),
        watch(
          () => [props.color, props.sizePx] as const,
          () => layer.setStyle(style()),
        ),
      ];
      return () => {
        for (const stop of stops) stop();
        stack.remove(layer);
      };
    });
    return () => null;
  },
});

/**
 * A UI control of the enclosing globe (`@vibeglobe/ui`): pass a control instance (`new ZoomControl()`, an application's
 * own `UiControl`). Unmounting removes it from the globe's UI; a new instance replaces the old one.
 */
export const VibeControl = defineComponent({
  name: 'VibeControl',
  props: {
    control: { type: Object as PropType<UiControl>, required: true },
  },
  setup(props) {
    onAttached('VibeControl', async (extras) => {
      const ui = await extras.ui();
      let current = props.control;
      ui.add(current);
      const stop = watch(
        () => props.control,
        (next) => {
          ui.remove(current.id);
          current = next;
          ui.add(next);
        },
      );
      return () => {
        stop();
        ui.remove(current.id);
      };
    });
    return () => null;
  },
});
