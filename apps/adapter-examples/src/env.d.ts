import type { DefineComponent } from 'vue';

declare module '*.vue' {
  const component: DefineComponent;
  export default component;
}

declare module 'vue' {
  interface GlobalComponents {
    /** The Web Component, used as a custom element in `ElementApp.vue`: attributes and DOM events pass through. */
    'vibe-globe': DefineComponent<{
      baseImageryUrl: string;
      backend: string;
      center: string;
      zoom: string;
      onReady: (event: Event) => void;
      onLoad: (event: Event) => void;
      onCameraChange: (event: Event) => void;
      onGlobeClick: (event: Event) => void;
    }>;
  }
}
